const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/outputs', express.static(path.join(__dirname, 'outputs')));

if (!fs.existsSync('./outputs')) fs.mkdirSync('./outputs');

// --- GEMINI: analizza la pagina ---
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
  const cursor = document.createElement('div');
  cursor.id = '__demo_cursor__';
  cursor.style.cssText = \`
    position: fixed;
    width: 24px;
    height: 24px;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='white' stroke='black' stroke-width='1.5' d='M5 2l14 9-7 2-4 7z'/%3E%3C/svg%3E") no-repeat center/contain;
    pointer-events: none;
    z-index: 999999;
    left: 100px;
    top: 100px;
    transition: left 0.15s ease, top 0.15s ease;
  \`;
  document.body.appendChild(cursor);

  window.__moveCursor__ = (x, y) => {
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  };
`;

app.post('/generate', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const id = crypto.randomUUID();
  const gifPath = `./outputs/${id}.gif`;

  let browser;
  try {
    // 1. Scarica HTML per Gemini
    let html = '';
    try {
      const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      html = await pageRes.text();
    } catch (_) {}

    // 2. Analizza con Gemini
    console.log('Analyzing page with Gemini...');
    const plan = await analyzePage(html);
    console.log('Plan:', JSON.stringify(plan));

    // 3. Avvia Playwright
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: './outputs/', size: { width: 1280, height: 720 } }
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500);

    // 4. Inietta cursore animato
    await page.evaluate(CURSOR_JS);
    await page.waitForTimeout(300);

    // 5. Muovi cursore al centro
    await page.evaluate(() => window.__moveCursor__(640, 360));
    await page.waitForTimeout(500);

    // 6. Scroll fluido
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

    // 7. Torna su
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(800);

    // 8. Typing nel campo principale (se rilevato)
    if (plan.primary_input && plan.suggested_typing) {
      try {
        const inputEl = await page.$(plan.primary_input);
        if (inputEl) {
          const box = await inputEl.boundingBox();
          if (box) {
            // Muovi cursore verso l'input
            await page.evaluate(({ x, y }) => window.__moveCursor__(x, y),
              { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
            await page.waitForTimeout(400);
          }
          await page.click(plan.primary_input, { timeout: 3000 });
          await page.type(plan.primary_input, plan.suggested_typing, { delay: 100 });
          await page.waitForTimeout(800);
        }
      } catch (e) {
        console.log('Input interaction skipped:', e.message);
      }
    }

    // 9. Click CTA (se rilevato)
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
        console.log('CTA click skipped:', e.message);
      }
    }

    await context.close();
    await browser.close();

    // 10. Trova il video registrato
    const files = fs.readdirSync('./outputs').filter(f => f.endsWith('.webm'));
    const latest = files.map(f => ({
      f, t: fs.statSync(`./outputs/${f}`).mtimeMs
    })).sort((a, b) => b.t - a.t)[0]?.f;

    if (!latest) throw new Error('Video not found');

    const actualVideo = `./outputs/${latest}`;

    // 11. Converti in GIF
    execSync(`ffmpeg -i ${actualVideo} -t 15 -vf "fps=8,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 ${gifPath}`);

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = `${proto}://${req.get('host')}`;
    res.json({
      gif_url: `${host}/outputs/${id}.gif`,
      mp4_url: `${host}/outputs/${latest}`
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
