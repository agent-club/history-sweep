const scatterMs = 1200;
const fadeMs = 520;
const reflowMs = 520;
const clamp = value => Math.max(0, Math.min(1, value));
const easeOut = value => 1 - (1 - clamp(value)) ** 3;
const random = seed => { const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return value - Math.floor(value); };

export { layout as captureRemovalLayout, texture as captureRowTexture };

function layout(container) {
  const nodes = [...container.querySelectorAll('.history-row, .group-header, .date-header')];
  return new Map(nodes.map(node => {
    const key = node.matches('.history-row') ? `row:${node.querySelector('.row-select').dataset.url}`
      : node.matches('.date-header') ? `day:${node.parentElement.dataset.date}`
      : `site:${node.closest('.date-group')?.dataset.date || ''}:${node.parentElement.dataset.group}`;
    return [key, { node, top: node.getBoundingClientRect().top }];
  }));
}

async function texture(row, bounds) {
  const copy = row.cloneNode(true);
  const originals = [row, ...row.querySelectorAll('*')];
  const copies = [copy, ...copy.querySelectorAll('*')];
  for (const [index, original] of originals.entries()) {
    const clone = copies[index];
    const style = getComputedStyle(original);
    // Resolve the live theme and typography before detaching the row from its table.
    for (const property of style) clone.style.setProperty(property, style.getPropertyValue(property));
    clone.removeAttribute('id');
    if (original instanceof HTMLInputElement) {
      clone.toggleAttribute('checked', original.checked);
      clone.removeAttribute('disabled');
    }
    if (original instanceof HTMLImageElement) {
      // SVG image contexts cannot load external resources. Inline already-loaded icons locally.
      const icon = document.createElement('canvas');
      icon.width = original.naturalWidth; icon.height = original.naturalHeight;
      if (!icon.width || !icon.height) { clone.remove(); continue; }
      icon.getContext('2d').drawImage(original, 0, 0);
      clone.src = icon.toDataURL(); clone.removeAttribute('srcset');
    }
  }
  copy.querySelector('.row-hover-trail')?.remove();
  copy.style.backgroundColor = getComputedStyle(row).getPropertyValue('--field');
  for (const [index, cell] of [...copy.cells].entries()) {
    cell.style.width = `${row.cells[index].getBoundingClientRect().width}px`;
    cell.style.minWidth = cell.style.width; cell.style.maxWidth = cell.style.width;
  }
  const table = document.createElementNS('http://www.w3.org/1999/xhtml', 'table');
  Object.assign(table.style, { margin: '0', width: `${bounds.width}px`, height: `${bounds.height}px`, tableLayout: 'fixed', borderCollapse: 'collapse', borderSpacing: '0' });
  const body = document.createElement('tbody'); body.append(copy); table.append(body);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(table)}</foreignObject></svg>`;
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  await image.decode();
  return image;
}

function scatter(canvas, image, bounds, signal) {
  const context = canvas.getContext('2d');
  const ratio = Math.min(devicePixelRatio, 2);
  const top = Math.max(0, bounds.top - 160);
  const height = Math.min(innerHeight - top, bounds.height + 320);
  canvas.width = Math.ceil(innerWidth * ratio); canvas.height = Math.ceil(height * ratio);
  Object.assign(canvas.style, { position: 'fixed', zIndex: '39', left: '0', top: `${top}px`, width: `${innerWidth}px`, height: `${height}px`, pointerEvents: 'none' });
  context.scale(ratio, ratio);
  const columns = Math.ceil(bounds.width / 10), rows = Math.ceil(bounds.height / 10);
  const width = bounds.width / columns, tileHeight = bounds.height / rows;
  const particles = Array.from({ length: columns * rows }, (_, index) => ({
    x: index % columns * width, y: Math.floor(index / columns) * tileHeight,
    rx: random(index + 8), ry: random(index + 48), seed: index + 1,
  }));
  return new Promise(resolve => {
    let frame; const start = performance.now();
    const finish = success => { cancelAnimationFrame(frame); signal.removeEventListener('abort', cancel); resolve(success); };
    const cancel = () => finish(false);
    signal.addEventListener('abort', cancel, { once: true });
    function draw(now) {
      if (signal.aborted) return finish(false);
      const elapsed = now - start;
      const fade = easeOut((elapsed - scatterMs) / fadeMs);
      context.clearRect(0, 0, canvas.width / ratio, canvas.height / ratio);
      for (const { x, y, rx, ry, seed } of particles) {
        const delay = rx * 120;
        const progress = clamp((elapsed - delay) / (scatterMs - delay));
        const expand = easeOut(progress);
        const cx = x + width / 2, cy = y + tileHeight / 2;
        const dx = (cx / bounds.width - .5) * (80 + rx * 100) * expand * .9 + Math.sin(seed) * 12 * progress + fade * (200 + rx * 240);
        const dy = (cy / bounds.height - .5) * (80 + ry * 145) * expand * .9 + (ry - .5) * 50 * expand + Math.sin(seed * 1.7 + progress * 4) * 12 * progress;
        const scale = (1 - .42 * expand) * (1 - fade * .72);
        context.save();
        context.globalAlpha = (1 - fade) * (1 - .25 * progress);
        context.translate(bounds.left + cx + dx, bounds.top - top + cy + dy);
        context.rotate(((rx - .5) * 90 * progress + fade * (rx - .5) * 22) * Math.PI / 180);
        context.scale(scale, scale);
        context.drawImage(image, x, y, width, tileHeight, -width / 2, -tileHeight / 2, width, tileHeight);
        context.restore();
      }
      if (elapsed >= scatterMs + fadeMs) return finish(true);
      frame = requestAnimationFrame(draw);
    }
    draw(start);
  });
}

// Called only for a single URL whose removal has already been verified by the worker.
// The hidden original reserves its slot until the pixels have exited; render then performs FLIP.
export async function animateRowRemoval(container, url, render) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches || document.hidden) return;
  const row = [...container.querySelectorAll('.history-row')].find(node => node.querySelector('.row-select').dataset.url === url);
  if (!row) return;
  const bounds = row.getBoundingClientRect(), viewport = container.getBoundingClientRect();
  if (!bounds.width || !bounds.height || bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) return;
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  const cancel = () => lifetime.abort();
  const listen = (target, type, handler, capture = false) => target.addEventListener(type, handler, { signal, capture });
  listen(document, 'scroll', cancel, true);
  listen(window, 'resize', cancel);
  listen(window, 'pagehide', cancel);
  listen(document, 'visibilitychange', () => { if (document.hidden) cancel(); });
  listen(motion, 'change', () => { if (motion.matches) cancel(); });
  const canvas = document.createElement('canvas');
  canvas.className = 'row-removal-pixels'; canvas.setAttribute('aria-hidden', 'true'); canvas.inert = true;
  const visibility = row.style.visibility;
  const animations = [];
  try {
    let image;
    try { image = await texture(row, bounds); }
    // An unavailable cosmetic snapshot must not turn a verified deletion into a failure.
    catch { return; }
    if (signal.aborted || !row.isConnected) return;
    const before = layout(container);
    row.style.visibility = 'hidden';
    document.body.append(canvas);
    if (!await scatter(canvas, image, bounds, signal) || !container.isConnected) return;
    canvas.remove();
    render();
    for (const [key, position] of layout(container)) {
      const previous = before.get(key);
      if (!previous) continue;
      const offset = previous.top - position.top;
      if (Math.abs(offset) > .5) animations.push(position.node.animate([
        { transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' },
      ], { duration: reflowMs, easing: 'cubic-bezier(.22,1,.36,1)' }));
    }
    const stop = () => animations.forEach(animation => animation.cancel());
    signal.addEventListener('abort', stop, { once: true });
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  } finally {
    lifetime.abort();
    animations.forEach(animation => animation.cancel());
    row.style.visibility = visibility;
    canvas.remove();
  }
}
