const { chromium, browserOptions, runtime, extension } = require('./browser-config.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');

(async () => {
  await fs.mkdir(runtime, { recursive: true });
  process.env.TEMP = process.env.TMP = runtime;
  const profile = await fs.mkdtemp(path.join(runtime, 'inspect-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions, headless: true, viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = context.pages()[0];
    await page.goto(process.argv[2] || 'https://live.bilibili.com/7902350', {
      waitUntil: 'domcontentloaded', timeout: 25000,
    }).catch(error => console.log(error.message));
    await page.waitForTimeout(12000);
    const info = [];
    for (const frame of page.frames()) {
      info.push(await frame.evaluate(() => ({
        url: location.href, title: document.title,
        text: document.body.innerText.slice(0, 1700),
        videos: [...document.querySelectorAll('video')].map(video => {
          const ancestors = [];
          for (let node = video; node && ancestors.length < 9; node = node.parentElement) {
            const rect = node.getBoundingClientRect();
            ancestors.push({ tag: node.tagName, id: node.id, cls: node.className,
              width: rect.width, height: rect.height });
          }
          return { ready: video.readyState, paused: video.paused, ancestors };
        }),
        frames: [...document.querySelectorAll('iframe')].map(node => ({
          src: node.src, id: node.id, cls: node.className,
        })),
      })).catch(error => ({ error: error.message })));
    }
    await fs.writeFile(path.join(runtime, 'initial.json'), JSON.stringify(info, null, 2));
    await page.screenshot({ path: path.join(runtime, 'initial.png') });
    console.log(JSON.stringify(info, null, 2));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
