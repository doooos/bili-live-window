const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { chromium, runtime, extension, browserOptions } = require('./browser-config.cjs');

(async () => {
  await fs.mkdir(runtime, { recursive: true });
  process.env.TEMP = process.env.TMP = runtime;
  const fixture = await fs.readFile(path.join(__dirname, 'fixture.html'), 'utf8');
  const profile = await fs.mkdtemp(path.join(runtime, 'test-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const errors = [];
  const checks = [];
  const ok = name => { checks.push(name); console.log('PASS '+name); };
  context.setDefaultTimeout(7000);
  const page = context.pages()[0];
  page.on('pageerror', error => errors.push(error.message));
  const style = async target => target.locator('#original-danmaku').evaluate(node => {
    const css = getComputedStyle(node);
    return Object.fromEntries(['fontSize','fontFamily','fontWeight','color','opacity','textShadow']
      .map(key => [key,css[key]]));
  });
  const open = async () => {
    const next = context.waitForEvent('page');
    await page.locator('#blw-entry button').click();
    const pip = await next;
    await pip.locator('#original-danmaku').waitFor();
    return pip;
  };
  try {
    await context.route('https://live.bilibili.com/**', route => route.fulfill({
      contentType:'text/html', body:fixture,
    }));
    await page.goto('https://live.bilibili.com/12345');
    await page.locator('#blw-entry button').waitFor();
    ok('real extension content script loaded');
    await page.waitForFunction(() => !fixture.video.paused && fixture.video.readyState >= 2);
    const before = await style(page);
    let pip = await open();
    ok('real Document Picture-in-Picture opened');
    assert.deepEqual(await style(pip), before);
    assert.equal(await page.evaluate(() => fixture.root.ownerDocument !== document
      && fixture.root.querySelector('#original-danmaku') === fixture.danmaku
      && fixture.root.querySelector('video') === fixture.video), true);
    ok('same video/danmaku nodes and original computed styling preserved');
    await page.evaluate(() => fixture.addDanmaku());
    assert.equal(await pip.locator('.danmaku span').count(), 2);
    ok('original player continues adding danmaku in floating window');
    await pip.locator('#style').click();
    const changed = await style(pip);
    assert.equal(changed.fontSize, '32px');
    assert.equal(changed.opacity, '0.8');
    await pip.locator('#cssom').click();
    await pip.waitForFunction(() => getComputedStyle(document.querySelector('#original-danmaku')).letterSpacing === '3px');
    ok('player setting changes and original CSSOM changes reach danmaku');
    const t0 = await page.evaluate(() => fixture.video.currentTime);
    await page.waitForFunction(time => fixture.video.currentTime > time + .2, t0);
    await pip.locator('#mute').click();
    assert.equal(await page.evaluate(() => fixture.video.muted), false);
    ok('playback continues and original control handlers work');
    await pip.screenshot({ path:path.join(runtime,'pip-test.png') });
    await pip.locator('#blw-return').click();
    await page.locator('#live-player-ctnr').waitFor();
    assert.equal(await page.evaluate(() => fixture.root.parentElement.matches('.player-section')), true);
    assert.equal((await style(page)).fontSize, '32px');
    await page.waitForFunction(() => !fixture.video.paused);
    ok('return restores original position, settings and playing state');
    pip = await open();
    await pip.locator('#pause').click();
    await page.waitForFunction(() => fixture.video.paused);
    await pip.close();
    await page.locator('#live-player-ctnr').waitFor();
    assert.equal(await page.evaluate(() => fixture.video.paused), true);
    ok('closing window restores player without overriding intentional pause');
    pip = await open();
    await page.locator('#blw-placeholder button').click();
    await page.locator('#live-player-ctnr').waitFor();
    assert.equal(pip.isClosed(), true);
    ok('source page restore and repeated opening work');
    await page.evaluate(() => fixture.root.remove());
    await page.locator('#blw-entry button').click();
    await page.locator('#blw-entry p').filter({hasText:'没有找到'}).waitFor();
    ok('missing live player produces a visible message');
    assert.deepEqual(errors, []);
    ok('no page JavaScript errors');
    await fs.writeFile(path.join(runtime,'test-results.json'), JSON.stringify({
      passed:true, browser:context.browser()?.version(), fixtureOnly:true, checks, originalStyle:before,
    },null,2));
  } finally { await context.close(); }
})().catch(error => { console.error(error.stack); process.exitCode=1; });
