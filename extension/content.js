(() => {
  'use strict';
  if (window !== window.top || document.getElementById('blw-entry')) return;

  let active = null;
  let opening = false;
  let noticeTimer = 0;

  const host = document.createElement('div');
  host.id = 'blw-entry';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all:initial; position:fixed!important; right:24px!important; bottom:24px!important;
        z-index:2147483647!important; font-family:"Segoe UI","Microsoft YaHei",sans-serif!important; }
      button { display:flex; gap:8px; align-items:center; border:1px solid #66cee9; border-radius:24px;
        color:#f6fcff; background:#172a38; padding:11px 17px; cursor:pointer; font-size:14px;
        box-shadow:0 5px 24px #0005; }
      button:hover { background:#214357; }
      button:disabled { cursor:wait; opacity:.7; }
      button:focus-visible { outline:3px solid #fff; outline-offset:3px; }
      svg { width:18px; height:18px; }
      p { display:none; max-width:290px; font-size:13px; line-height:1.6; color:#fff;
        background:#172a38; padding:12px; border-radius:10px; box-shadow:0 5px 24px #0005; }
      p[data-visible] { display:block; }
    </style>
    <p role="status" aria-live="polite"></p>
    <button type="button" title="原播放器置顶小窗 · Alt+Shift+P">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <rect x="2" y="4" width="20" height="16" rx="2"></rect>
        <rect x="11" y="11" width="8" height="6" rx="1" fill="currentColor"></rect>
      </svg><span>直播小窗</span>
    </button>`;
  document.documentElement.append(host);
  const entry = shadow.querySelector('button');
  const label = shadow.querySelector('span');
  const notice = shadow.querySelector('p');

  function say(message) {
    clearTimeout(noticeTimer);
    notice.textContent = message;
    notice.setAttribute('data-visible', '');
    noticeTimer = setTimeout(() => notice.removeAttribute('data-visible'), 9000);
  }

  function findPlayer() {
    const candidates = [...document.querySelectorAll('video')].filter(video => {
      const rect = video.getBoundingClientRect();
      return rect.width >= 150 && rect.height >= 80;
    }).sort((a, b) => {
      const x = a.getBoundingClientRect(), y = b.getBoundingClientRect();
      return y.width * y.height - x.width * x.height;
    });
    for (const video of candidates) {
      // Move the live mount, including danmaku and controls, never clone the video.
      const root = video.closest('#live-player-ctnr')
        || video.closest('#live-player')
        || video.closest('.bilibili-live-player')
        || video.closest('.web-player');
      if (root && root !== document.body) return { root, video };
    }
    return null;
  }

  function refreshLayout(state) {
    if (active !== state) return;
    // Bilibili's player still has its original Window listeners.
    window.dispatchEvent(new Event('resize'));
    state.pip.dispatchEvent(new state.pip.Event('resize'));
  }

  function copyStyles(state) {
    if (active !== state || state.pip.closed) return;
    const doc = state.pip.document;
    const fragment = doc.createDocumentFragment();
    for (const source of document.querySelectorAll('style,link[rel~="stylesheet"]')) {
      if (state.root.contains(source)) continue;
      let copy;
      if (source.tagName === 'LINK') {
        copy = doc.createElement('link');
        copy.rel = 'stylesheet';
        copy.href = source.href;
        copy.media = source.media;
        copy.disabled = source.disabled;
        if (source.crossOrigin) copy.crossOrigin = source.crossOrigin;
        if (source.integrity) copy.integrity = source.integrity;
        copy.addEventListener('load', () => refreshLayout(state), { once: true });
      } else {
        copy = doc.createElement('style');
        copy.media = source.media;
        // Some players insert CSS rules through CSSOM rather than textContent.
        try {
          copy.textContent = [...source.sheet.cssRules].map(rule => rule.cssText).join('\n');
        } catch { copy.textContent = source.textContent; }
      }
      copy.dataset.blwCopied = '';
      fragment.append(copy);
    }
    for (const sheet of document.adoptedStyleSheets || []) {
      const copy = doc.createElement('style');
      try { copy.textContent = [...sheet.cssRules].map(rule => rule.cssText).join('\n'); }
      catch { continue; }
      copy.dataset.blwCopied = '';
      fragment.append(copy);
    }
    doc.head.querySelectorAll('[data-blw-copied]').forEach(node => node.remove());
    doc.head.insertBefore(fragment, state.override);
  }

  function restore(state) {
    if (state.restored) return;
    state.restored = true;
    state.styleObserver?.disconnect();
    state.bodyObserver?.disconnect();
    state.ancestorObserver?.disconnect();
    clearTimeout(state.styleTimer);
    clearInterval(state.watchdog);
    window.removeEventListener('pagehide', state.onOwnerHide);
    const { root, marker, parent, next, pip } = state;
    // The source may have navigated to another live room while the window was open.
    // Do not append an old stream into the new room.
    const resume = !state.video.paused;
    if (marker.isConnected) marker.replaceWith(root);
    else if (parent.isConnected) parent.insertBefore(root, next?.parentNode === parent ? next : null);
    else {
      root.querySelectorAll('video').forEach(video => video.pause());
      root.remove();
    }
    if (state.previousAttribute === null) root.removeAttribute('data-blw-player');
    else root.setAttribute('data-blw-player', state.previousAttribute);
    if (active === state) active = null;
    label.textContent = '直播小窗';
    entry.disabled = false;
    if (!pip.closed) pip.close();
    window.dispatchEvent(new Event('resize'));
    if (root.ownerDocument === document && root.isConnected && resume && state.video.paused) {
      state.video.play().catch(() => {});
    }
  }

  function preserveAncestors(state, stage) {
    // Scoped site CSS may depend on parent classes or Vue's data-v-* attributes.
    // These are empty layout shells. The real player/danmaku nodes remain intact.
    const ancestors = [];
    for (let node = state.root.parentElement; node && node !== document.body; node = node.parentElement) {
      ancestors.unshift(node);
    }
    let parent = stage;
    const pairs = [];
    for (const source of ancestors) {
      const copy = state.pip.document.createElement(
        /^(DIV|MAIN|SECTION|ARTICLE|ASIDE|HEADER)$/.test(source.tagName) ? source.tagName : 'div');
      const sync = () => {
        for (const attr of [...copy.attributes]) copy.removeAttribute(attr.name);
        for (const attr of source.attributes) {
          if (/^(id|class|style|dir|lang)$/.test(attr.name) || attr.name.startsWith('data-')) {
            copy.setAttribute(attr.name, attr.value);
          }
        }
        copy.setAttribute('data-blw-shell', '');
      };
      sync();
      parent.append(copy);
      parent = copy;
      pairs.push({ source, sync });
    }
    state.ancestorObserver = new MutationObserver(() => pairs.forEach(pair => pair.sync()));
    pairs.forEach(({ source }) => state.ancestorObserver.observe(source, { attributes: true }));
    return parent;
  }

  function setupWindow(state) {
    const { pip, root } = state;
    const doc = pip.document;
    doc.title = `直播小窗 · ${document.title}`;
    doc.documentElement.lang = 'zh-CN';
    doc.documentElement.className = document.documentElement.className;
    doc.body.className = document.body.className;
    // Preserve inherited site variables even after leaving the original ancestors.
    const inherited = getComputedStyle(root);
    for (const property of ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height',
      'color', 'letter-spacing', 'text-shadow', 'direction']) {
      doc.body.style.setProperty(property, inherited.getPropertyValue(property));
    }
    for (const property of inherited) {
      if (property.startsWith('--')) doc.body.style.setProperty(property, inherited.getPropertyValue(property));
    }
    const base = doc.createElement('base');
    base.href = document.baseURI;
    doc.head.append(base);
    state.override = doc.createElement('style');
    state.override.textContent = `
      html { min-width:0!important; min-height:0!important; width:100%!important; height:100%!important;
        overflow:hidden!important; background:#000!important; }
      body { margin:0!important; padding:0!important; min-width:0!important; min-height:0!important;
        width:100%!important; height:100%!important; overflow:hidden!important; background:#000!important; }
      #blw-layout { display:flex!important; flex-direction:column!important; width:100%!important;
        height:100%!important; min-width:0!important; min-height:0!important; }
      #blw-toolbar { box-sizing:border-box!important; display:flex!important; flex:0 0 36px!important;
        height:36px!important; align-items:center!important; gap:8px!important; padding:0 10px!important;
        color:#dce5ef!important; background:#141820!important; font:12px "Segoe UI","Microsoft YaHei",sans-serif!important; }
      #blw-title { flex:1!important; min-width:0!important; overflow:hidden!important;
        text-overflow:ellipsis!important; white-space:nowrap!important; }
      #blw-return { border:1px solid #465466!important; color:#dce5ef!important; background:#222e3b!important;
        padding:3px 10px!important; border-radius:5px!important; cursor:pointer!important;
        font:12px "Segoe UI","Microsoft YaHei",sans-serif!important; }
      #blw-stage { position:relative!important; flex:1 1 auto!important; min-height:0!important;
        min-width:0!important; overflow:hidden!important; background:#000!important; }
      [data-blw-shell] { display:block!important; position:static!important; float:none!important;
        width:100%!important; height:100%!important; min-width:0!important; min-height:0!important;
        max-width:none!important; max-height:none!important; margin:0!important; padding:0!important;
        border:0!important; transform:none!important; overflow:visible!important; }
      [data-blw-player] { position:absolute!important; inset:0!important; margin:0!important;
        width:100%!important; height:100%!important; min-width:0!important; min-height:0!important;
        max-width:none!important; max-height:none!important; transform:none!important; }
      #blw-stage #live-player, #blw-stage .bilibili-live-player, #blw-stage .web-player {
        width:100%!important; height:100%!important; min-width:0!important; min-height:0!important; }
      #blw-stage video { object-fit:contain!important; }
    `;
    doc.head.append(state.override);
    copyStyles(state);
    const layout = doc.createElement('div');
    layout.id = 'blw-layout';
    const toolbar = doc.createElement('div');
    toolbar.id = 'blw-toolbar';
    const title = doc.createElement('span');
    title.id = 'blw-title';
    title.textContent = document.title;
    const back = doc.createElement('button');
    back.id = 'blw-return';
    back.type = 'button';
    back.textContent = '返回网页';
    back.addEventListener('click', () => { window.focus(); restore(state); });
    toolbar.append(title, back);
    const stage = doc.createElement('div');
    stage.id = 'blw-stage';
    layout.append(toolbar, stage);
    doc.body.append(layout);
    const mount = preserveAncestors(state, stage);
    const rect = root.getBoundingClientRect();
    const marker = document.createElement('div');
    marker.id = 'blw-placeholder';
    marker.style.cssText = `box-sizing:border-box;width:100%;height:${Math.max(rect.height, 180)}px;display:flex;align-items:center;justify-content:center;background:#101722;color:#dce5ef;font:14px sans-serif;`;
    const bringBack = document.createElement('button');
    bringBack.type = 'button';
    bringBack.textContent = '直播正在小窗播放 · 点此放回网页';
    bringBack.style.cssText = 'cursor:pointer;border:1px solid #7293ab;border-radius:8px;padding:14px;background:#192b3c;color:#fff;';
    bringBack.addEventListener('click', () => restore(state));
    marker.append(bringBack);
    state.marker = marker;
    root.before(marker);
    root.setAttribute('data-blw-player', '');
    mount.append(root);
    const scheduleStyleCopy = () => {
      clearTimeout(state.styleTimer);
      state.styleTimer = setTimeout(() => copyStyles(state), 150);
    };
    state.styleObserver = new MutationObserver(scheduleStyleCopy);
    state.styleObserver.observe(document.head, { childList: true, subtree: true,
      characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
    state.bodyObserver = new MutationObserver(() => {
      doc.body.className = document.body.className;
      doc.documentElement.className = document.documentElement.className;
    });
    state.bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    state.bodyObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    // Settings can change stylesheet CSSOM without a DOM mutation.
    for (const event of ['input', 'change', 'pointerup', 'keyup']) {
      doc.addEventListener(event, scheduleStyleCopy, true);
    }
    pip.addEventListener('resize', () => window.dispatchEvent(new Event('resize')));
    pip.addEventListener('pagehide', () => restore(state), { once: true });
    state.onOwnerHide = () => restore(state);
    window.addEventListener('pagehide', state.onOwnerHide, { once: true });
    state.watchdog = setInterval(() => {
      if (pip.closed || !marker.isConnected || location.pathname !== state.pathname) restore(state);
    }, 750);
    refreshLayout(state);
    // Moving media to another Document can pause it. Only resume if already playing.
    if (state.wasPlaying && state.video.paused) state.video.play().catch(() => {});
    label.textContent = '放回网页';
  }

  async function openWindow() {
    if (active) { restore(active); return; }
    if (opening) return;
    if (!window.documentPictureInPicture?.requestWindow) {
      say('当前浏览器不支持网页小窗。请更新 Edge；普通视频画中画无法保留弹幕和网页控件。');
      return;
    }
    if (!/^\/\d+(?:\/|$)/.test(location.pathname)) {
      say('请先进入一个直播间，再打开小窗。');
      return;
    }
    const found = findPlayer();
    if (!found) {
      say('没有找到直播播放器。请先让直播画面加载，再重试。');
      return;
    }
    if (document.fullscreenElement) {
      say('请先退出全屏，再点「直播小窗」。');
      return;
    }
    opening = true;
    entry.disabled = true;
    let pip;
    try {
      // Must run directly inside a real click/key event, before any await or messaging.
      pip = await window.documentPictureInPicture.requestWindow({
        width: 800, height: 486, disallowReturnToOpener: false,
      });
      const state = { ...found, pip, parent: found.root.parentNode, next: found.root.nextSibling,
        marker: document.createElement('div'), pathname: location.pathname,
        previousAttribute: found.root.getAttribute('data-blw-player'),
        wasPlaying: !found.video.paused, restored: false };
      active = state;
      setupWindow(state);
    } catch (error) {
      if (active) restore(active);
      else if (pip && !pip.closed) pip.close();
      say(error?.name === 'NotAllowedError'
        ? '浏览器未允许打开小窗。请直接点击网页上的按钮，并检查小窗权限。'
        : '小窗未能打开，播放器已尝试恢复。请刷新直播页后重试。');
    } finally {
      opening = false;
      entry.disabled = false;
    }
  }

  entry.addEventListener('click', openWindow);
  document.addEventListener('keydown', event => {
    if (event.altKey && event.shiftKey && event.code === 'KeyP' && !event.repeat
      && !event.composedPath().some(node => node.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName))) {
      event.preventDefault();
      openWindow();
    }
  });
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, reply) => {
      if (message?.type !== 'bili-live-window:locate') return;
      entry.focus();
      say('点击这里，把原直播播放器移到置顶小窗。也可按 Alt+Shift+P。');
      reply({ ok: true });
    });
  }
})();
