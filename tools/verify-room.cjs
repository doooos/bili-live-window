const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium, browserOptions, runtime, extension } = require('./browser-config.cjs');

(async () => {
  await fs.mkdir(runtime, { recursive: true });
  process.env.TEMP = process.env.TMP = runtime;
  const profile = await fs.mkdtemp(path.join(runtime, 'verify-room-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions, headless: true, viewport: { width: 1400, height: 1000 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = context.pages()[0];
    page.on('console', message => {
      if (message.type() === 'error' || /MediaSource|destroy|remove|BLW/.test(message.text())) console.log(message.text().slice(0, 2000));
    });
    await page.goto(process.argv[2] || 'https://live.bilibili.com/7902350', {
      waitUntil: 'domcontentloaded', timeout: 25000,
    });
    await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => {
      try { return frame.contentDocument?.querySelector('#live-player video')?.readyState >= 2; }
      catch { return false; }
    }), {}, { timeout: 30000 });
    const source = page.frames().find(frame => /\/blanc\/7902350/.test(frame.url()));
    assert.ok(source, 'esports player iframe loaded');
    await source.waitForSelector('.web-player-danmaku', { state: 'attached' });
    await page.waitForTimeout(5000);
    await source.evaluate(() => {
      const video = [...document.querySelectorAll('video')].find(v => v.getBoundingClientRect().width > 150);
      const root = video.closest('#live-player-ctnr');
      const layer = root.querySelector('.web-player-danmaku');
      for (const type of ['error', 'emptied', 'abort', 'pause', 'loadstart']) video.addEventListener(type,
        () => console.log('BLW media', type, video.error?.code, video.error?.message, video.readyState));
      window.roomProbe = { video, layer, root, parent: root.parentNode, document, added: 0 };
      new MutationObserver(records => {
        for (const record of records) window.roomProbe.added += record.addedNodes.length;
      }).observe(layer, { childList: true, subtree: true });
    });
    const snapshot = () => source.evaluate(() => {
      const p = window.roomProbe;
      return {
        time: p.video.currentTime, paused: p.video.paused, ready: p.video.readyState,
        added: p.added, danmakuNodes: p.layer.querySelectorAll('*').length,
        moved: p.root.ownerDocument !== document,
        sourceVideoKept: p.video.ownerDocument === document,
        sameDocument: p.document === document,
        sameNodes: p.root.contains(p.layer),
        restored: p.root.parentNode === p.parent && p.root.ownerDocument === document,
      };
    });
    const before = await snapshot();
    const next = context.waitForEvent('page', { timeout: 10000 });
    await page.locator('#blw-entry button').click();
    const pip = await next;
    await pip.locator('#live-player video').waitFor({ state: 'attached', timeout: 5000 }).catch(() => {});
    await pip.setViewportSize({ width: 800, height: 486 });
    await pip.waitForTimeout(8000);
    const during = await snapshot();
    console.log(JSON.stringify({ before, during }));
    console.log(JSON.stringify(await pip.evaluate(() => ({
      text: document.body.innerText.slice(0, 600),
      videos: [...document.querySelectorAll('video')].map(v => ({ id: v.parentElement.id, paused: v.paused, time: v.currentTime })),
    }))));
    await pip.screenshot({ path: path.join(runtime, 'room7902350-pip.png') });
    assert.ok(during.moved && during.sameNodes && during.sameDocument && during.sourceVideoKept);
    assert.ok(during.time > before.time && !during.paused, 'live playback advances');
    assert.ok(await pip.locator('video').evaluate(v => v.readyState >= 2 && !v.paused && v.videoWidth > 0),
      'mirrored frames reach the window');
    await pip.locator('video').first().hover({ force: true });
    await pip.screenshot({ path: path.join(runtime, 'room7902350-pip.png') });
    await pip.close();
    await source.waitForFunction(() => {
      const p = window.roomProbe;
      return p.root.parentNode === p.parent && !p.video.paused;
    });
    const after = await snapshot();
    assert.ok(after.restored && after.sameNodes && after.sameDocument);
    const result = { passed: true, url: page.url(), source: source.url(), before, during, after };
    await fs.writeFile(path.join(runtime, 'room7902350-live.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } finally { await context.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
