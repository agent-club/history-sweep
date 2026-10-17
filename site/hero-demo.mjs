const video = document.getElementById('hero-delete-video');
const canvas = document.getElementById('hero-delete-particles');
const context = canvas.getContext('2d');
const surface = document.querySelector('.hero-surface');
const button = document.getElementById('hero-delete-toggle');
const motion = matchMedia('(prefers-reduced-motion: reduce)');
const assets = new Map();
const clamp = value => Math.max(0, Math.min(1, value));
const easeOut = value => 1 - (1 - clamp(value)) ** 3;
const random = seed => { const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };
let language;
let metadata;
let texture;
let visible = false;
let wantsPlayback = !motion.matches;
let failed = false;
let frame;
let width = 0;
let height = 0;

function controls() {
  const zh = document.documentElement.lang === 'zh-CN';
  button.textContent = failed ? (zh ? '演示暂不可用' : 'Demo unavailable')
    : video.paused ? (zh ? '播放演示' : 'Play demo') : (zh ? '暂停演示' : 'Pause demo');
  button.disabled = failed;
  button.setAttribute('aria-pressed', String(!video.paused));
}

function draw() {
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (!metadata || !texture || motion.matches) return;
  const elapsed = (video.currentTime - metadata.scatterAt) * 1000;
  if (elapsed < 0 || elapsed > 1720) return;
  const scale = surface.clientWidth / metadata.width;
  const {row} = metadata;
  const columns = Math.ceil(row.width / 10), rows = Math.ceil(row.height / 10);
  const tileWidth = row.width / columns, tileHeight = row.height / rows;
  const fade = easeOut((elapsed - 1200) / 520);
  context.save();
  // Continue the native row texture only beyond the window edge; the video owns all interior pixels.
  context.beginPath(); context.rect(surface.clientWidth - 5, 0, width, height); context.clip();
  for (let index = 0; index < columns * rows; index++) {
    const x = index % columns * tileWidth, y = Math.floor(index / columns) * tileHeight;
    if (x < row.width * .6) continue;
    const rx = random(index + 8), ry = random(index + 48), seed = index + 1;
    const progress = clamp((elapsed - rx * 120) / (1200 - rx * 120));
    const expand = easeOut(progress);
    const cx = x + tileWidth / 2, cy = y + tileHeight / 2;
    // Match extension/row-removal.mjs, including its deterministic tile seeds and 1200+520ms lifetime.
    const dx = (cx / row.width - .5) * (80 + rx * 100) * expand * .9 + Math.sin(seed) * 12 * progress + fade * (200 + rx * 240);
    const dy = (cy / row.height - .5) * (80 + ry * 145) * expand * .9 + (ry - .5) * 50 * expand + Math.sin(seed * 1.7 + progress * 4) * 12 * progress;
    const size = (1 - .42 * expand) * (1 - fade * .72) * scale;
    context.save();
    context.globalAlpha = (1 - fade) * (1 - .25 * progress);
    context.translate((row.x + cx + dx) * scale, (row.y + cy + dy) * scale + 60);
    context.rotate(((rx - .5) * 90 * progress + fade * (rx - .5) * 22) * Math.PI / 180);
    context.scale(size, size);
    context.drawImage(texture, x * 2, y * 2, tileWidth * 2, tileHeight * 2, -tileWidth / 2, -tileHeight / 2, tileWidth, tileHeight);
    context.restore();
  }
  context.restore();
}

function animate() { draw(); frame = requestAnimationFrame(animate); }
function reconcile() {
  cancelAnimationFrame(frame);
  const running = wantsPlayback && visible && !document.hidden && document.documentElement.dataset.introActive !== 'true' && !failed;
  if (running) {
    video.play().catch(error => {
      if (error.name !== 'AbortError') { wantsPlayback = false; controls(); }
    });
    if (context && !motion.matches) frame = requestAnimationFrame(animate);
  } else video.pause();
  controls();
}

function renderLanguage() {
  const next = document.documentElement.lang === 'zh-CN' ? 'zh' : 'en';
  if (next === language) return;
  language = next; failed = false; metadata = undefined; texture = undefined;
  context?.clearRect(0, 0, width, height);
  video.poster = `assets/single-delete-${next}.png`;
  video.preload = motion.matches ? 'none' : 'metadata';
  video.src = `assets/single-delete-${next}.mp4`;
  video.setAttribute('aria-label', next === 'zh' ? '单条历史记录删除与像素消散演示' : 'Single-record deletion and pixel dissolve demonstration');
  if (!assets.has(next)) assets.set(next, Promise.all([
    fetch(`assets/single-delete-${next}.json`).then(response => { if (!response.ok) throw new Error('Demo metadata unavailable'); return response.json(); }),
    new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = `assets/single-delete-row-${next}.png`; }),
  ]));
  assets.get(next).then(([data, image]) => { if (next === language) { metadata = data; texture = image; draw(); } }).catch(() => {});
  reconcile();
}

video.muted = true; video.loop = true;
video.addEventListener('loadedmetadata', reconcile);
video.addEventListener('error', () => { failed = true; wantsPlayback = false; reconcile(); });
for (const event of ['play', 'pause']) video.addEventListener(event, controls);
button.addEventListener('click', () => {
  wantsPlayback = video.paused;
  if (wantsPlayback) surface.scrollIntoView({block: 'nearest', behavior: motion.matches ? 'instant' : 'smooth'});
  reconcile();
});
new IntersectionObserver(([entry]) => { visible = entry.isIntersecting && entry.intersectionRatio >= .2; reconcile(); }, {threshold: .2}).observe(surface);
new ResizeObserver(() => {
  width = canvas.clientWidth; height = canvas.clientHeight;
  const density = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * density); canvas.height = Math.round(height * density);
  context?.setTransform(density, 0, 0, density, 0, 0); draw();
}).observe(canvas);
new ResizeObserver(([entry]) => document.querySelector('.hero').style.setProperty('--hero-art-height', `${entry.target.getBoundingClientRect().height + 120}px`)).observe(document.querySelector('.hero-lead'));
new MutationObserver(renderLanguage).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
new MutationObserver(reconcile).observe(document.documentElement, {attributes: true, attributeFilter: ['data-intro-active']});
document.addEventListener('visibilitychange', reconcile);
motion.addEventListener('change', () => { if (motion.matches) wantsPlayback = false; context?.clearRect(0, 0, width, height); reconcile(); });
renderLanguage();
