const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { chromium, runtime, extension, browserOptions } = require('./browser-config.cjs');

(async () => {
  await fs.mkdir(runtime, { recursive: true });
  process.env.TEMP = process.env.TMP = runtime;
  const fixture = await fs.readFile(path.join(__dirname, 'fixture.html'), 'utf8');
  const profile = await fs.mkdtemp(path.join(runtime, 'frame-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions, headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  context.setDefaultTimeout(8000);
  const page = context.pages()[0];
  const checks = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const ok = name => { checks.push(name); console.log('PASS ' + name); };
  const open = async () => {
    const next = context.waitForEvent('page');
    await page.locator('#blw-entry button').click();
    const pip = await next;
    await pip.locator('#original-danmaku').waitFor();
    return pip;
  };
  const style = target => target.locator('#original-danmaku').evaluate(node => {
    const css = getComputedStyle(node);
    return Object.fromEntries(['fontSize', 'fontFamily', 'fontWeight', 'color', 'opacity', 'textShadow']
      .map(key => [key, css[key]]));
  });
  try {
    await context.route('https://example.org/**', route => route.fulfill({ body: '<p>Other origin</p>' }));
    await context.route('https://live.bilibili.com/**', route => route.fulfill({
      contentType: 'text/html', body: new URL(route.request().url()).pathname.startsWith('/blanc/')
        ? fixture : '<iframe id="player" style="width:1100px;height:650px" src="/blanc/7902350?liteVersion=true"></iframe><iframe src="https://example.org/"></iframe>',
    }));
    await page.goto('https://live.bilibili.com/7902350');
    const frame = page.frames().find(item => item.url().includes('/blanc/'));
    await frame.waitForFunction(() => !fixture.video.paused && fixture.video.readyState >= 2);
    assert.equal(await page.locator('video').count(), 0);
    assert.equal(await page.locator('#blw-entry').count(), 1);
    await frame.evaluate(() => {
      window.resizeCount = 0;
      window.addEventListener('resize', () => window.resizeCount++);
      window.originalDocument = document;
    });
    const before = await style(frame);
    let pip = await open();
    assert.deepEqual(await style(pip), before);
    assert.equal(await frame.evaluate(() => fixture.root.ownerDocument !== document
      && fixture.video.ownerDocument === document && fixture.video.isConnected
      && fixture.root.querySelector('video') !== fixture.video
      && fixture.root.querySelector('#original-danmaku') === fixture.danmaku), true);
    await pip.waitForFunction(() => {
      const video = document.querySelector('[data-blw-preview]');
      return video && video.readyState >= 2 && !video.paused && video.muted
        && video.srcObject.getAudioTracks().length === 0;
    });
    ok('esports iframe preserves source video, native overlays and danmaku styling with a muted video mirror');
    await frame.evaluate(() => fixture.addDanmaku());
    assert.equal(await pip.locator('.danmaku span').count(), 2);
    const t0 = await frame.evaluate(() => fixture.video.currentTime);
    await frame.waitForFunction(time => fixture.video.currentTime > time + .2, t0);
    await pip.locator('#mute').click();
    assert.equal(await frame.evaluate(() => fixture.video.muted), false);
    assert.ok(await frame.evaluate(() => resizeCount > 0));
    ok('iframe playback, incoming danmaku, native controls and resize handlers continue');
    await pip.locator('#style').click();
    assert.equal((await style(pip)).fontSize, '32px');
    await pip.locator('#cssom').click();
    await pip.waitForFunction(() => getComputedStyle(document.querySelector('#original-danmaku')).letterSpacing === '3px');
    ok('iframe player settings and CSSOM changes reach the floating window');
    await pip.locator('#blw-return').click();
    await frame.locator('#live-player-ctnr').waitFor();
    assert.equal(await frame.evaluate(() => document === originalDocument
      && fixture.root.parentElement.matches('.player-section')
      && fixture.root.ownerDocument === document
      && fixture.root.querySelector('video') === fixture.video
      && !document.querySelector('[data-blw-preview]')), true);
    await frame.waitForFunction(() => !fixture.video.paused);
    ok('return restores the same iframe document and playing stream without reloading');
    pip = await open();
    await frame.waitForFunction(() => !fixture.video.paused);
    await pip.locator('#pause').click();
    await frame.waitForFunction(() => fixture.video.paused);
    await pip.close();
    await frame.locator('#live-player-ctnr').waitFor();
    assert.equal(await frame.evaluate(() => fixture.video.paused), true);
    ok('reopening and intentional pause work inside an iframe');
    pip = await open();
    const closed = pip.waitForEvent('close');
    await page.locator('#player').evaluate(node => node.remove());
    await closed;
    ok('removing the source iframe closes its floating player');
    await page.locator('#blw-entry button').click();
    await page.locator('#blw-entry p').filter({ hasText: '没有找到' }).waitFor();
    ok('cross-origin iframe alone is ignored without throwing');
    await page.goto('https://live.bilibili.com/blanc/7902350');
    await page.waitForFunction(() => !fixture.video.paused && fixture.video.readyState >= 2);
    pip = await open();
    await pip.close();
    await page.locator('#live-player-ctnr').waitFor();
    ok('direct /blanc/ room URLs also work');
    assert.deepEqual(errors, []);
    ok('no page JavaScript errors');
    await fs.writeFile(path.join(runtime, 'frame-test-results.json'), JSON.stringify({
      passed: true, fixtureOnly: true, browser: context.browser()?.version(), checks,
    }, null, 2));
  } finally { await context.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
