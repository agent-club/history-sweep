import http from 'node:http';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';

const records = Array.from({ length: 12 }, (_, index) => ({
  id: String(index), url: `https://example.test/design/${index}`, title: ['产品设计规范文档', '设计灵感收集', '周末阅读清单'][index % 3],
  lastVisitTime: Date.parse('2026-10-01T14:20:00+08:00') - index * 3600000, visitCount: 1,
}));
const scripts = [];
await installMock({ addInitScript: async (script, value) => {
  scripts.push(typeof script === 'function' ? `(${script.toString()})(${JSON.stringify(value)});` : script);
} }, records);
const fixture = scripts.join('\n') + `
const previewState = new URLSearchParams(location.search).get('state');
localStorage.setItem('language', 'zh-CN');
window.__updateAnimationLog = [];
document.body.dataset.previewErrors = '0';
document.addEventListener('animationstart', event => {
  if (event.animationName === 'update-drop') {
    window.__updateAnimationLog.push(event.animationName);
    document.body.dataset.updateAnimations = String(window.__updateAnimationLog.length);
  }
});
window.addEventListener('error', event => { window.__previewErrors ||= []; window.__previewErrors.push(event.message); document.body.dataset.previewErrors = String(window.__previewErrors.length); });
window.addEventListener('unhandledrejection', event => { window.__previewErrors ||= []; window.__previewErrors.push(String(event.reason)); document.body.dataset.previewErrors = String(window.__previewErrors.length); });
const reload = chrome.runtime.reload;
chrome.runtime.reload = () => { reload(); document.body.dataset.reloads = String(window.__reloads); };
if (previewState === 'reduce') {
  const media = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const result = media(query);
    if (query === '(prefers-reduced-motion: reduce)') Object.defineProperty(result, 'matches', { value: true });
    return result;
  };
}
await import('/extension/app.mjs');
document.querySelector('#query').value = 'example.test';
document.querySelector('#searchForm').requestSubmit();
const ready = setInterval(async () => {
  if (document.querySelector('#search').disabled) return;
  clearInterval(ready);
  document.querySelector('#selectAll').click();
  if (previewState === 'task') {
    // Only synthetic fixture records are touched; each phase stays visible for animation review.
    const remove = chrome.history.deleteUrl;
    chrome.history.deleteUrl = async args => { await new Promise(resolve => setTimeout(resolve, 1000)); return remove(args); };
    const verify = chrome.history.getVisits;
    chrome.history.getVisits = async args => { await new Promise(resolve => setTimeout(resolve, 2000)); return verify(args); };
    document.querySelector('#delete').click();
    document.querySelector('#confirmDialog [value=confirm]').click();
  }
  setTimeout(() => window.__updateAvailable('0.3.2'), 500);
}, 30);
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data === 'repeat-update-event') window.__updateAvailable('0.3.2');
  if (event.data === 'fail-update') {
    chrome.runtime.reload = () => { throw new Error('Demo update failure'); };
  }
});
`;
const frame = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><base href="/extension/"><meta name="viewport" content="width=device-width,initial-scale=1"><title>更新横幅预览</title><link rel="stylesheet" href="app.css"></head><body data-layout="popup"><div id="app"></div><script type="module" src="/design/update-preview/fixture.mjs"></script></body></html>';
const files = createServer();
http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/design/update-preview/fixture.mjs' || pathname === '/design/update-preview/popup.html') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', pathname.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    res.end(pathname.endsWith('.mjs') ? fixture : frame);
  } else files.emit('request', req, res);
}).listen(4190, '127.0.0.1', () => console.log('Update preview: http://127.0.0.1:4190/design/update-preview/'));
