import './site.mjs';
import './question-intro.mjs';
import './feature-lab.mjs';
import './hero-demo.mjs';
import {initializePixelSweep} from './pixel-sweep.mjs';

const video = document.getElementById('product-video');
const demo = document.getElementById('demo');
const toggle = document.getElementById('film-toggle');
const timer = document.getElementById('film-time');
const expand = document.getElementById('film-expand');
const filmWindow = document.querySelector('.film-window');
const chapters = [...document.querySelectorAll('[data-chapter]')];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const pixelSweep = initializePixelSweep({
  canvas: document.getElementById('pixel-sweep'),
  button: document.getElementById('ambient-toggle'),
  reducedMotion,
});
// These chapter boundaries match the 600-frame Remotion composition at 30 fps.
const duration = 20;
let currentLanguage;
let visible = false;
let wantsPlayback = !reducedMotion.matches;
let failed = false;
let seekTime = 0;

function updateControls() {
  const zh = currentLanguage === 'zh-CN';
  expand.querySelector('span').textContent = document.fullscreenElement
    ? (zh ? '退出全屏' : 'Exit full screen') : (zh ? '全屏观看' : 'Full screen');
  toggle.textContent = failed ? (zh ? '演示暂不可用' : 'Demo unavailable')
    : video.paused ? (zh ? '播放演示' : 'Play demo') : (zh ? '暂停演示' : 'Pause demo');
  toggle.disabled = failed;
  toggle.setAttribute('aria-pressed', String(!video.paused));
  const time = Math.min(video.currentTime || 0, duration);
  timer.replaceChildren(`00:${String(Math.floor(time)).padStart(2, '0')} `);
  const end = document.createElement('span');
  end.textContent = '/ 00:20';
  timer.append(end);
  demo.style.setProperty('--film-progress', String(time / duration));
  const active = chapters.findLastIndex(button => time >= Number(button.dataset.chapter));
  for (const [index, chapter] of chapters.entries()) {
    chapter.setAttribute('aria-pressed', String(active === index));
  }
}

function reconcilePlayback() {
  if (wantsPlayback && visible && !document.hidden && document.documentElement.dataset.introActive !== 'true' && !failed) {
    const source = video.src;
    video.play().catch(error => {
      // Source switches and offscreen pauses can abort an otherwise valid play request.
      if (source !== video.src || error.name === 'AbortError') return;
      wantsPlayback = false;
      updateControls();
    });
  } else {
    video.pause();
  }
  updateControls();
}

function renderLanguage() {
  const nextLanguage = document.documentElement.lang;
  if (nextLanguage === currentLanguage) return;
  const zh = nextLanguage === 'zh-CN';
  seekTime = currentLanguage ? video.currentTime : 0;
  currentLanguage = nextLanguage;
  failed = false;
  video.setAttribute('aria-label', zh ? 'History Sweep 产品功能演示' : 'History Sweep product demonstration');
  document.querySelector('.film-chapters').setAttribute('aria-label', zh ? '选择功能演示章节' : 'Explore the demonstration');
  document.querySelector('.nav-links').setAttribute('aria-label', zh ? '主要导航' : 'Main navigation');
  document.querySelector('.workflow-steps').setAttribute('aria-label', zh ? '历史清理流程' : 'Cleanup workflow');
  document.querySelector('.support').setAttribute('aria-label', zh ? '帮助与安装' : 'Help and installation');
  pixelSweep.renderLanguage();
  document.querySelector('.manager-frame img').src = `assets/product-still-${zh ? 'zh' : 'en'}.png`;
  video.poster = `assets/product-demo-${zh ? 'zh' : 'en'}.png`;
  video.preload = reducedMotion.matches ? 'none' : 'metadata';
  video.src = `assets/product-demo-${zh ? 'zh' : 'en'}.mp4`;
  updateControls();
}

function seekTo(time) {
  seekTime = time;
  wantsPlayback = true;
  if (video.readyState >= 1) video.currentTime = time;
  else video.load();
  reconcilePlayback();
}

video.muted = true;
video.loop = true;
video.addEventListener('loadedmetadata', () => {
  video.currentTime = Math.min(seekTime, Math.max(0, video.duration - 1 / 30));
  reconcilePlayback();
});
for (const event of ['timeupdate', 'seeked', 'play', 'pause']) video.addEventListener(event, updateControls);
video.addEventListener('error', () => { failed = true; wantsPlayback = false; updateControls(); });
toggle.addEventListener('click', () => {
  wantsPlayback = video.paused;
  reconcilePlayback();
});
expand.hidden = !document.fullscreenEnabled;
expand.addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await filmWindow.requestFullscreen();
  } catch {
    // An embedded browser may expose the API while disallowing fullscreen.
    expand.hidden = true;
  }
});
document.addEventListener('fullscreenchange', updateControls);
for (const chapter of chapters) chapter.addEventListener('click', () => seekTo(Number(chapter.dataset.chapter)));
document.getElementById('watch-demo').addEventListener('click', () => {
  demo.scrollIntoView({block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth'});
  seekTo(0);
});
document.querySelectorAll('[data-jump-demo]').forEach(button => button.addEventListener('click', () => {
  demo.scrollIntoView({block: 'center', behavior: reducedMotion.matches ? 'instant' : 'smooth'});
  seekTo(Number(button.dataset.jumpDemo));
}));
new IntersectionObserver(([entry]) => { visible = entry.isIntersecting && entry.intersectionRatio >= 0.2; reconcilePlayback(); }, {threshold: 0.2}).observe(video);
document.addEventListener('visibilitychange', reconcilePlayback);
new MutationObserver(reconcilePlayback).observe(document.documentElement, {attributes: true, attributeFilter: ['data-intro-active']});
reducedMotion.addEventListener('change', () => {
  if (reducedMotion.matches) { wantsPlayback = false; reconcilePlayback(); }
});
new MutationObserver(renderLanguage).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
renderLanguage();

const workflowButtons = [...document.querySelectorAll('[data-workflow]')];
const workflowPanels = [...document.querySelectorAll('[data-workflow-panel]')];
for (const button of workflowButtons) button.addEventListener('click', () => {
  for (const item of workflowButtons) item.setAttribute('aria-pressed', String(item === button));
  for (const panel of workflowPanels) panel.hidden = panel.dataset.workflowPanel !== button.dataset.workflow;
});
