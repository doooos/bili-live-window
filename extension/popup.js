'use strict';
document.getElementById('locate').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https:\/\/live\.bilibili\.com\/\d+(?:[/?#]|$)/.test(tab.url || '')) {
      status.textContent = '请先打开一个 B 站直播间。直播首页没有播放器。';
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: 'bili-live-window:locate' });
    window.close();
  } catch {
    status.textContent = '请刷新直播间，再点网页右下角「直播小窗」。';
  }
});
