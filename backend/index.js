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

app.post('/generate', async (req, res) => {
  const { url, plan } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const id = crypto.randomUUID();
  const videoPath = `./outputs/${id}.webm`;
  const gifPath = `./outputs/${id}.gif`;

  let browser;
  try {
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

    // --- SCROLL FLUIDO ---
    await page.evaluate(async () => {
      await new Promise(resolve => {
        let pos = 0;
        const max = Math.min(document.body.scrollHeight, 3000); // max 3000px
        const step = () => {
          pos += 15; // più veloce
          window.scrollTo({ top: pos, behavior: 'smooth' });
          if (pos < max) requestAnimationFrame(step);
          else setTimeout(resolve, 500);
        };
        requestAnimationFrame(step);
      });
    });
    await page.waitForTimeout(500); // ridotto da 1000

   

    // --- SCROLL TORNA SU ---
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(1000);

    // --- TYPING (se il piano lo prevede) ---
    if (plan?.primary_input && plan?.suggested_typing) {
      try {
        await page.click(plan.primary_input, { timeout: 3000 });
        await page.type(plan.primary_input, plan.suggested_typing, { delay: 100 });
        await page.waitForTimeout(800);
      } catch (_) {}
    }

    // --- CLICK CTA (se il piano lo prevede) ---
    if (plan?.main_cta) {
      try {
        await page.click(plan.main_cta, { timeout: 3000 });
        await page.waitForTimeout(1500);
      } catch (_) {}
    }

    await context.close();
    await browser.close();

    // Trova il video registrato
    const files = fs.readdirSync('./outputs').filter(f => f.endsWith('.webm'));
    const latest = files.map(f => ({
      f, t: fs.statSync(`./outputs/${f}`).mtimeMs
    })).sort((a, b) => b.t - a.t)[0]?.f;

    if (!latest) throw new Error('Video not found');

    const actualVideo = `./outputs/${latest}`;

    // Converti in GIF con ffmpeg
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

app.listen(3000, () => console.log('Backend running on port 3000'));
