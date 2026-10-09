const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium, runtime, extension, browserOptions } = require('./browser-config.cjs');

(async () => {
  await fs.mkdir(runtime, { recursive: true });
  process.env.TEMP = runtime;
  process.env.TMP = runtime;
  const profile = await fs.mkdtemp(path.join(runtime, 'live-profile-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserOptions,
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const page = context.pages()[0];
    page.setDefaultTimeout(5000);
    await page.goto(process.argv[2] || 'https://live.bilibili.com/5050', {
      waitUntil: 'domcontentloaded', timeout: 20000,
    }).catch(error => console.log('Navigation: '+error.message.split('\n')[0]));
    await page.waitForSelector('#live-player video', { timeout: 12000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelector('.bili-danmaku-x-dm'),
      { }, { timeout: 25000 }).catch(() => console.log('DANMAKU_NOT_READY'));
    await page.evaluate(() => {
      const container = document.querySelector('.web-player-danmaku');
      window.blwProbe = { container, added: 0, video: document.querySelector('video'),
        sample: container?.querySelector('.bili-danmaku-x-dm'),
        snapshot() {
          const view = this.container?.ownerDocument.defaultView;
          return {
            added: this.added, nodes: this.container?.querySelectorAll('*').length,
            time: this.video?.currentTime, sourceVisibility: document.visibilityState,
            moved: this.container?.ownerDocument !== document,
            sampleStyle: this.sample && view && Object.fromEntries(
              ['fontFamily', 'fontSize', 'fontWeight', 'color', 'opacity', 'textShadow']
                .map(k => [k, view.getComputedStyle(this.sample)[k]])),
          };
        } };
      if (container) new MutationObserver(records => {
        for (const record of records) window.blwProbe.added += record.addedNodes.length;
      }).observe(container, { childList: true, subtree: true });
    });
    await page.waitForTimeout(5000);
    const summary = await page.evaluate(() => {
      const video = document.querySelector('video');
      const ancestors = [];
      for (let node = video; node && ancestors.length < 8; node = node.parentElement) {
        ancestors.push({ tag: node.tagName, id: node.id, class: node.className,
          rect: node.getBoundingClientRect().toJSON() });
      }
      return {
        url: location.href,
        title: document.title,
        pip: !!window.documentPictureInPicture,
        video: video && { readyState: video.readyState, paused: video.paused, width: video.videoWidth },
        ancestors,
        controls: [...document.querySelectorAll('[class*="control"],[class*="danmaku"],[class*="chat"]')]
          .slice(0, 65).map(n => ({ tag: n.tagName, id: n.id, class: n.className })),
        playerHTML: document.querySelector('#player-section')?.outerHTML.slice(0, 30000)
          || document.querySelector('#live-player-ctnr')?.outerHTML.slice(0, 30000),
      };
    });
    await fs.writeFile(path.join(runtime,'live-inspection.json'),JSON.stringify(summary,null,2));
    console.log(JSON.stringify({url:summary.url,title:summary.title,pip:summary.pip,video:summary.video},null,2));
    await page.screenshot({ path: path.join(runtime, 'live-before.png') });
    if (summary.video?.readyState >= 2) {
      const before = await page.evaluate(() => window.blwProbe.snapshot());
      const next = context.waitForEvent('page');
      await page.locator('#blw-entry button').click();
      const pip = await next;
      await pip.locator('video').waitFor();
      await pip.setViewportSize({ width: 800, height: 486 });
      await pip.waitForTimeout(8000);
      const after = await page.evaluate(() => window.blwProbe.snapshot());
      const details = await pip.evaluate(() => ({
        danmaku: document.querySelector('.web-player-danmaku')?.outerHTML.slice(0, 8000),
        controls: document.querySelector('#web-player-controller-wrap-el')?.shadowRoot?.innerHTML.slice(0, 24000)
          || document.querySelector('#web-player-controller-wrap-el')?.outerHTML.slice(0, 24000),
      }));
      const other = await context.newPage();
      await other.goto('about:blank');
      await other.bringToFront();
      await page.waitForTimeout(6000);
      const background = await page.evaluate(() => window.blwProbe.snapshot());
      await fs.writeFile(path.join(runtime, 'live-danmaku.json'), JSON.stringify({before, after, background, details}, null, 2));
      console.log('LIVE_DANMAKU', JSON.stringify({before, after, background}));
      await pip.locator('video').hover({ force: true });
      await pip.screenshot({path:path.join(runtime,'live-pip.png')});
      console.log('LIVE_PIP_OPENED');
      await pip.close();
      await page.locator('#live-player video').waitFor();
      console.log('LIVE_PLAYER_RESTORED');
    }
  } finally {
    await context.close();
  }
})().catch(e => { console.error(e.message); process.exitCode = 1; });
