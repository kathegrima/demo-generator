const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.options('*', cors());
app.use(express.json());
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

if (!fs.existsSync('./outputs')) fs.mkdirSync('./outputs');

const jobs = {};

// --- GEMINI ---
async function analyzePage(html) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { has_scroll: true, scroll_depth: 'full' };

  const prompt = `
Analyze this HTML landing page and return ONLY a raw JSON object (no markdown, no backticks) with:
- has_scroll: boolean
- primary_input: CSS selector of the main input field, or null
- suggested_typing: realistic example text for the input coherent with site context, or null
- main_cta: CSS selector of the main CTA button, or null
- scroll_depth: "full" or "half"

HTML:
${html.slice(0, 15000)}
  `;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await res.json();
    let raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    raw = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(raw);
  } catch (e) {
    console.error('Gemini error:', e.message);
    return { has_scroll: true, scroll_depth: 'full' };
  }
}

// --- CURSORE ANIMATO ---
const CURSOR_JS = `
  (function() {
    var cursor = document.createElement('div');
    cursor.id = '__demo_cursor__';
    cursor.style.position = 'fixed';
    cursor.style.width = '28px';
    cursor.style.height = '28px';
    cursor.style.backgroundImage = "url(\\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='28' height='28' viewBox='0 0 24 24'%3E%3Cpath fill='white' stroke='black' stroke-width='1.5' d='M5 2l14 9-7 2-4 7z'/%3E%3C/svg%3E\\")";
    cursor.style.backgroundRepeat = 'no-repeat';
    cursor.style.backgroundSize = 'contain';
    cursor.style.pointerEvents = 'none';
    cursor.style.zIndex = '999999';
    cursor.style.left = '100px';
    cursor.style.top = '100px';
    cursor.style.transition = 'left 0.2s ease, top 0.2s ease';
    document.body.appendChild(cursor);
    window.__moveCursor__ = function(x, y) {
      cursor.style.left = x + 'px';
      cursor.style.top = y + 'px';
    };
  })();
`;

// --- JOB RUNNER ---
async function runJob(id, url) {
  let browser;
  const gifPath = `./outputs/${id}.gif`;

  try {
    // 1. Scarica HTML
    let html = '';
    try {
      const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      html = await pageRes.text();
    } catch (_) {}

    // 2. Analizza con Gemini
    console.log(`[${id}] Analyzing with Gemini...`);
    const plan = await analyzePage(html);
    console.log(`[${id}] Plan:`, JSON.stringify(plan));

    // 3. Avvia browser
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: './outputs/', size: { width: 1280, height: 720 } }
    });

    // 4. Blocca script cookie/analytics di terze parti
    await context.route('**/*', (route) => {
      const url = route.request().url();
      const blocked = [
        'cookiebot', 'onetrust', 'cookiehub', 'gdpr',
        'cookieyes', 'quantcast', 'trustarc', 'cookielaw',
        'usercentrics', 'didomi'
      ];
      if (blocked.some(b => url.includes(b))) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    // 5. Rimuovi cookie banners via DOM
    await page.evaluate(() => {
      const selectors = [
        '#cookie-banner', '#cookie-notice', '#cookie-consent',
        '#cookieConsent', '#gdpr-banner', '#onetrust-banner-sdk',
        '#CybotCookiebotDialog', '#cookie-law-info-bar',
        '.cookie-banner', '.cookie-notice', '.cookie-bar',
        '.cookie-consent', '.gdpr', '.cc-banner', '.cookieConsent',
        '[class*="cookie-banner"]', '[id*="cookie-banner"]',
        '[class*="gdpr-banner"]', '[id*="gdpr-banner"]',
        '[class*="consent-banner"]'
      ];
      selectors.forEach(sel => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      });
      document.body.style.overflow = 'auto';
      document.documentElement.style.overflow = 'auto';
    });
    await page.waitForTimeout(300);

    // 6. Clicca "Accept" se presente
    const acceptSelectors = [
      '#onetrust-accept-btn-handler',
      'button[id*="accept"]', 'button[class*="accept"]',
      'a[id*="accept"]', 'a[class*="accept"]',
      'button[id*="agree"]', 'button[class*="agree"]',
      '.cc-accept', '.cc-btn', '[data-testid*="accept"]'
    ];
    for (const sel of acceptSelectors) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click();
          await page.waitForTimeout(600);
          break;
        }
      } catch (_) {}
    }

    // 7. Inietta cursore
    await page.evaluate(CURSOR_JS);
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__moveCursor__(640, 360));
    await page.waitForTimeout(500);

    // 8. Scroll fluido
    const scrollMax = plan.scroll_depth === 'half' ? 0.5 : 1.0;
    await page.evaluate(async (maxRatio) => {
      await new Promise(resolve => {
        let pos = 0;
        const max = document.body.scrollHeight * maxRatio;
        const step = () => {
          pos += 15;
          window.scrollTo({ top: pos, behavior: 'smooth' });
          if (pos < max) requestAnimationFrame(step);
          else setTimeout(resolve, 500);
        };
        requestAnimationFrame(step);
      });
    }, scrollMax);
    await page.waitForTimeout(800);

    // 9. Torna su
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(800);

    // 10. Typing
    if (plan.primary_input && plan.suggested_typing) {
      try {
        const inputEl = await page.$(plan.primary_input);
        if (inputEl) {
          const box = await inputEl.boundingBox();
          if (box) {
            await page.evaluate(({ x, y }) => window.__moveCursor__(x, y),
              { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
            await page.waitForTimeout(400);
          }
          await page.click(plan.primary_input, { timeout: 3000 });
          await page.type(plan.primary_input, plan.suggested_typing, { delay: 100 });
          await page.waitForTimeout(800);
        }
      } catch (e) {
        console.log(`[${id}] Input skipped:`, e.message);
      }
    }

    // 11. Click CTA
    if (plan.main_cta) {
      try {
        const ctaEl = await page.$(plan.main_cta);
        if (ctaEl) {
          const box = await ctaEl.boundingBox();
          if (box) {
            await page.evaluate(({ x, y }) => window.__moveCursor__(x, y),
              { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
            await page.waitForTimeout(400);
          }
          await page.click(plan.main_cta, { timeout: 3000 });
          await page.waitForTimeout(1500);
        }
      } catch (e) {
        console.log(`[${id}] CTA skipped:`, e.message);
      }
    }

    await context.close();
    await browser.close();
    browser = null;

    // 12. Trova video
    const files = fs.readdirSync('./outputs').filter(f => f.endsWith('.webm'));
    const latest = files.map(f => ({
      f, t: fs.statSync(`./outputs/${f}`).mtimeMs
    })).sort((a, b) => b.t - a.t)[0]?.f;

    if (!latest) throw new Error('Video not found');

    // 13. Converti in GIF
    execSync(`ffmpeg -i ./outputs/${latest} -t 15 -vf "fps=8,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 ${gifPath}`);

    const RAILWAY_URL = `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'demo-generator-production-f2db.up.railway.app'}`;
    jobs[id] = {
      status: 'done',
      gif_url: `${RAILWAY_URL}/outputs/${id}.gif`,
      mp4_url: `${RAILWAY_URL}/outputs/${latest}`
    };
    console.log(`[${id}] Done!`);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(`[${id}] Error:`, err.message);
    jobs[id] = { status: 'error', error: err.message };
  }
}

// --- ENDPOINTS ---
app.post('/start', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  const id = crypto.randomUUID();
  jobs[id] = { status: 'processing' };
  runJob(id, url);
  res.json({ job_id: id });
});

app.get('/status/:id', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
