import { captureRemovalLayout, captureRowTexture } from './row-removal.mjs';

const windMs = 2550;
const scrollMs = 1950;
const reflowMs = 600;
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => { const p = clamp(value); return p * p * (3 - 2 * p); };
const random = seed => { const n = Math.sin(seed * 127.1 + 311.7) * 43758.5453; return n - Math.floor(n); };

async function headerTexture(node, bounds) {
  const copy = node.cloneNode(true);
  const originals = [node, ...node.querySelectorAll('*')], copies = [copy, ...copy.querySelectorAll('*')];
  for (const [index, original] of originals.entries()) {
    const clone = copies[index], style = getComputedStyle(original);
    for (const property of style) clone.style.setProperty(property, style.getPropertyValue(property));
    clone.removeAttribute('id');
    if (original instanceof HTMLInputElement) clone.toggleAttribute('checked', original.checked);
    if (original instanceof HTMLImageElement) {
      if (!original.naturalWidth || !original.naturalHeight) { clone.remove(); continue; }
      const icon = document.createElement('canvas'); icon.width = original.naturalWidth; icon.height = original.naturalHeight;
      icon.getContext('2d').drawImage(original, 0, 0); clone.src = icon.toDataURL(); clone.removeAttribute('srcset');
    }
  }
  Object.assign(copy.style, { position: 'relative', top: '0', left: '0', margin: '0', width: `${bounds.width}px`, height: `${bounds.height}px` });
  const wrapper = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
  Object.assign(wrapper.style, { width: `${bounds.width}px`, height: `${bounds.height}px`, overflow: 'hidden', background: getComputedStyle(node.closest('.group-header, .date-header')).backgroundColor });
  wrapper.append(copy);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(wrapper)}</foreignObject></svg>`;
  const image = new Image(); image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  await image.decode(); return image;
}

function foreground(image, bounds) {
  const source = document.createElement('canvas');
  source.width = Math.ceil(bounds.width); source.height = Math.ceil(bounds.height);
  const context = source.getContext('2d', { willReadFrequently: true });
  context.drawImage(image, 0, 0, source.width, source.height);
  const pixels = context.getImageData(0, 0, source.width, source.height);
  const data = pixels.data, colors = new Map();
  for (let offset = 0; offset < data.length; offset += 16) {
    if (!data[offset + 3]) continue;
    const key = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    colors.set(key, (colors.get(key) || 0) + 1);
  }
  const background = [...colors].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (background === undefined) return { source, tiles: [] };
  const red = background >> 16, green = background >> 8 & 255, blue = background & 255;
  for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
    const offset = (y * source.width + x) * 4;
    const contrast = Math.max(Math.abs(data[offset] - red), Math.abs(data[offset + 1] - green), Math.abs(data[offset + 2] - blue));
    // Contrast works in both themes; the flat row fill and separator do not become confetti.
    data[offset + 3] = y >= source.height - 2 ? 0 : Math.round(data[offset + 3] * clamp((contrast - 8) / 28));
  }
  context.putImageData(pixels, 0, 0);
  const width = Math.max(5, Math.round(8 * Math.min(1, bounds.width / 994)));
  const height = Math.max(4, Math.round(6 * Math.min(1, bounds.height / 61)));
  const tiles = [];
  for (let y = 0; y < source.height - 2; y += height) for (let x = 0; x < source.width; x += width) {
    const w = Math.min(width, source.width - x), h = Math.min(height, source.height - 2 - y);
    let weight = 0, red = 0, green = 0, blue = 0;
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) {
      const offset = (py * source.width + px) * 4, alpha = data[offset + 3] / 255;
      weight += alpha; red += data[offset] * alpha; green += data[offset + 1] * alpha; blue += data[offset + 2] * alpha;
    }
    if (weight < .7) continue;
    tiles.push({ x, y, width: w, height: h, density: weight / (w * h), color: `rgb(${Math.round(red / weight)},${Math.round(green / weight)},${Math.round(blue / weight)})` });
  }
  return { source, tiles };
}

function scrollPoint(row, tile, p, seed) {
  const bounds = row.bounds, unit = Math.min(1, Math.max(.55, bounds.width / 1032));
  const sx = bounds.left + (tile.x + tile.width / 2) * row.scaleX, sy = bounds.top + (tile.y + tile.height / 2) * row.scaleY;
  const cx = bounds.left + bounds.width * .65, cy = bounds.top + bounds.height / 2;
  const rx = random(seed + 7), ry = random(seed + 47), pull = smooth(p / .58), turn = smooth((p - .2) / .65);
  const theta = Math.atan2(sy - cy, sx - cx) + turn * Math.PI * 3.2;
  const radius = (12 + rx * 38) * unit * smooth(p / .35) * (1 - smooth((p - .65) / .35));
  const escape = smooth((p - .67) / .33);
  return { x: sx + (cx - sx) * pull + Math.cos(theta) * radius * Math.sin(pull * Math.PI / 2) + escape * (155 + rx * 75) * unit, y: sy + (cy - sy) * pull + Math.sin(theta) * radius - escape * (30 + ry * 38) * unit };
}

function drawScroll(context, row, elapsed) {
  const unit = Math.min(1, Math.max(.55, row.bounds.width / 1032));
  context.save(); context.globalAlpha = Math.sin(clamp((elapsed - .4) / 1.25) * Math.PI) * .15;
  context.translate(row.bounds.left + row.bounds.width * .65, row.bounds.top + row.bounds.height / 2); context.rotate(elapsed * 130 * Math.PI / 180);
  context.strokeStyle = row.inkColor; context.lineWidth = 1; context.setLineDash([31, 60, 15, 90]);
  context.beginPath(); context.ellipse(0, 0, 37 * unit, 25 * unit, 0, 0, Math.PI * 2); context.stroke();
  context.lineWidth = .7; context.setLineDash([14, 180]); context.beginPath(); context.ellipse(0, 0, 50 * unit, 34 * unit, 0, 0, Math.PI * 2); context.stroke(); context.restore();
  for (const [index, tile] of row.tiles.entries()) {
    const rx = random(index + 7), ry = random(index + 47);
    const age = elapsed - .22 - (1 - (tile.x + tile.width / 2) / row.source.width) * .15 - rx * .18;
    const p = clamp(age / 1.35);
    if (age <= 0 || p >= 1) continue;
    const point = scrollPoint(row, tile, p, index), previous = scrollPoint(row, tile, Math.max(0, p - .012), index);
    const opacity = smooth(age / .09) * (1 - smooth((p - .72) / .28)), scale = 1 - smooth(p) * .72;
    if (p > .25) {
      context.globalAlpha = opacity * .15; context.strokeStyle = tile.color; context.lineWidth = .65;
      context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(point.x, point.y); context.stroke();
    }
    context.save(); context.globalAlpha = opacity; context.translate(point.x, point.y);
    context.rotate(((rx - .5) * 50 + smooth(p) * (rx > .5 ? 210 : -160)) * Math.PI / 180); context.scale(scale * row.scaleX, scale * row.scaleY);
    context.drawImage(row.source, tile.x, tile.y, tile.width, tile.height, -tile.width / 2, -tile.height / 2, tile.width, tile.height); context.restore();
    if (p > .56 && rx > .55) {
      context.globalAlpha = opacity * .35 * Math.sin(p * Math.PI); context.fillStyle = tile.color;
      context.beginPath(); context.arc(point.x - (5 + rx * 13) * unit, point.y + Math.sin(p * 8 + index) * 8 * unit, .65 + ry * .6, 0, Math.PI * 2); context.fill();
    }
  }
}

function wind(canvas, rows, viewport, signal, beginReflow) {
  const context = canvas.getContext('2d');
  const ratio = Math.min(devicePixelRatio, 2);
  canvas.width = Math.ceil(innerWidth * ratio); canvas.height = Math.ceil(innerHeight * ratio);
  Object.assign(canvas.style, { position: 'fixed', inset: '0', zIndex: '39', width: `${innerWidth}px`, height: `${innerHeight}px`, pointerEvents: 'none' });
  context.scale(ratio, ratio);
  const windRows = rows.filter(row => row.kind === 'row'), field = windRows.length ? windRows : rows;
  const duration = windRows.length ? windMs : scrollMs;
  const left = Math.min(...field.map(row => row.bounds.left));
  const width = Math.max(...field.map(row => row.bounds.right)) - left;
  const top = field[0].bounds.top, height = field[0].bounds.height;
  const point = (row, tile, p, seed) => {
    const x = row.bounds.left + (tile.x + tile.width / 2) * row.scaleX;
    const y = row.bounds.top + (tile.y + tile.height / 2) * row.scaleY;
    const rx = random(seed + 7), ry = random(seed + 47);
    const drift = width * (.724 + rx * .171) * p ** 1.5;
    const bend = smooth((x + drift - left - width * .562) / (width * .513));
    const lane = top + height * (.36 + row.rank * .4 + (ry - .5) * .65);
    const flutter = Math.sin(p * 7 + seed) * Math.sin(p * Math.PI);
    return { x: x + drift + flutter * height * .1, y: y + (lane - y) * bend - Math.sin(p * Math.PI) * height * .148 + flutter * height * .066 };
  };
  return new Promise(resolve => {
    let frame, reflowStarted = false; const started = performance.now();
    const finish = success => { cancelAnimationFrame(frame); signal.removeEventListener('abort', cancel); resolve(success); };
    const cancel = () => finish(false);
    signal.addEventListener('abort', cancel, { once: true });
    function draw(now) {
      if (signal.aborted) return finish(false);
      const elapsed = (now - started) / 1000;
      if (!reflowStarted && now - started >= duration * .8) {
        reflowStarted = true;
        try { beginReflow(); } catch { return finish(false); }
      }
      context.clearRect(0, 0, innerWidth, innerHeight);
      context.save();
      context.beginPath(); context.rect(viewport.left, viewport.top, viewport.width, viewport.height); context.clip();
      // Once the list moves, only transparent particles remain above it.
      for (const row of reflowStarted ? [] : rows) {
        const bounds = row.bounds;
        context.globalAlpha = 1;
        context.fillStyle = row.surface; context.fillRect(bounds.left, bounds.top, bounds.width, bounds.height);
        if (row.kind === 'scroll') {
          const tighten = smooth(elapsed / .22), sx = 1 - tighten * .035, sy = 1 - tighten * .09;
          context.save(); context.globalAlpha = 1 - smooth((elapsed - .22) / .42);
          context.translate(bounds.left + bounds.width * .65, bounds.top + bounds.height / 2); context.scale(sx, sy);
          context.drawImage(row.image, -bounds.width * .65, -bounds.height / 2, bounds.width, bounds.height); context.restore(); continue;
        }
        for (let x = 0; x < row.image.width; x += 8) {
          const strip = Math.min(8, row.image.width - x);
          const release = .18 + (1 - (x + 4) / row.image.width) * .62 + row.rank * .13;
          context.globalAlpha = 1 - smooth((elapsed - release) / .12);
          if (context.globalAlpha > 0) context.drawImage(row.image, x, 0, strip, row.image.height, bounds.left + x * row.scaleX, bounds.top, (strip + .1) * row.scaleX, bounds.height);
        }
      }
      for (const row of rows) {
        if (row.kind === 'scroll') { drawScroll(context, row, elapsed); continue; }
        for (const [index, tile] of row.tiles.entries()) {
          const seed = index + row.index * 1201, rx = random(seed + 7), ry = random(seed + 47);
          const release = .18 + (1 - (tile.x + tile.width / 2) / row.source.width) * .62 + row.rank * .13;
          const age = elapsed - release;
          if (age <= .015) continue;
          const p = clamp(age / (1.25 + rx * .16));
          if (p >= 1) continue;
          const current = point(row, tile, p, seed), previous = point(row, tile, Math.max(0, p - .014), seed);
          const opacity = smooth(age / .08) * (1 - smooth((p - .58) / .42));
          const scale = (1 - smooth(p) * .77) * (1 + Math.sin(p * Math.PI) * .08);
          if (p > .28) {
            context.globalAlpha = opacity * .12 * Math.sin(p * Math.PI); context.strokeStyle = tile.color;
            context.lineWidth = .55 + ry * .35; context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(current.x, current.y); context.stroke();
          }
          context.save(); context.globalAlpha = opacity; context.translate(current.x, current.y);
          context.rotate(Math.sin(seed + p * 5) * p * 30 * Math.PI / 180); context.scale(scale * row.scaleX, scale * row.scaleY);
          context.drawImage(row.source, tile.x, tile.y, tile.width, tile.height, -tile.width / 2, -tile.height / 2, tile.width, tile.height); context.restore();
          if (p > .22 && tile.density > .12 && rx > .52) {
            context.fillStyle = tile.color; context.globalAlpha = opacity * .36 * Math.sin(p * Math.PI);
            context.beginPath(); context.arc(current.x - 8 - ry * 16, current.y + Math.sin(p * 9 + seed) * 7, .6 + ry * .65, 0, Math.PI * 2); context.fill();
            if (rx > .77) {
              context.globalAlpha = opacity * .2 * Math.sin(p * Math.PI); context.beginPath(); context.arc(current.x - 19 - ry * 13, current.y + 6 + Math.sin(p * 6) * 6, .45 + rx * .4, 0, Math.PI * 2); context.fill();
            }
          }
        }
      }
      context.restore();
      if (now - started >= duration) return finish(true);
      frame = requestAnimationFrame(draw);
    }
    draw(started);
  });
}

// Only verified batch success enters here. All textures stay in memory and are released on exit.
export async function animateBatchRemoval(container, urls, render) {
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  if (motion.matches || document.hidden) return;
  const retiring = new Set(urls), viewport = container.getBoundingClientRect();
  const target = (node, kind, partial = false) => {
    const bounds = node.getBoundingClientRect();
    return bounds.width && bounds.height && bounds.bottom > viewport.top && bounds.top < viewport.bottom ? [{ node, kind, partial, bounds, visibility: node.style.visibility }] : [];
  };
  const targets = [...container.querySelectorAll('.history-row')].flatMap(node => {
    if (!retiring.has(node.querySelector('.row-select').dataset.url)) return [];
    return target(node, 'row');
  });
  for (const group of container.querySelectorAll('.date-group, .website-group')) {
    const header = group.querySelector(':scope > .date-header, :scope > .group-header');
    if (header.querySelector('.date-toggle, .group-toggle').getAttribute('aria-expanded') !== 'false') continue;
    const count = group.historyItems.filter(item => retiring.has(item.url)).length;
    if (!count) continue;
    // A partially cleaned group stays present: only its selected-count label becomes particles.
    const partial = count < group.historyItems.length;
    const node = partial ? header.querySelector('.group-selected') : header;
    if (node) targets.push(...target(node, 'scroll', partial));
  }
  if (!targets.length) return;
  const lifetime = new AbortController(), signal = lifetime.signal, animations = [];
  let frameScroll, timeout;
  const cancel = () => { lifetime.abort(); animations.forEach(animation => animation.cancel()); };
  const listen = (target, type, handler, capture = false) => target.addEventListener(type, handler, { signal, capture });
  listen(document, 'scroll', event => {
    const node = event.target instanceof Element ? event.target : document.scrollingElement;
    const previous = frameScroll?.get(node);
    // Rendering may clamp the scroll offset. Ignore that already-accounted-for event, not user scrolling.
    if (previous && previous.top === node.scrollTop && previous.left === node.scrollLeft) return;
    cancel();
  }, true);
  listen(window, 'resize', cancel); listen(window, 'pagehide', cancel);
  listen(document, 'visibilitychange', () => { if (document.hidden) cancel(); });
  listen(document, 'history-sweep:theme-changed', cancel);
  listen(motion, 'change', () => { if (motion.matches) cancel(); });
  const canvas = document.createElement('canvas'); canvas.className = 'batch-removal-wind'; canvas.setAttribute('aria-hidden', 'true'); canvas.inert = true;
  let rows = [];
  try {
    const aborted = new Promise(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
    timeout = setTimeout(cancel, 800);
    rows = await Promise.race([Promise.all(targets.map(async (target, index) => {
      try {
        const image = await (target.kind === 'scroll' ? headerTexture : captureRowTexture)(target.node, target.bounds);
        if (signal.aborted) return null;
        const ink = foreground(image, target.bounds);
        const style = getComputedStyle(target.node);
        return { ...target, image, ...ink, index, rank: index / Math.max(1, targets.length - 1), scaleX: target.bounds.width / ink.source.width, scaleY: target.bounds.height / ink.source.height, surface: target.partial ? getComputedStyle(target.node.closest('.group-header, .date-header')).backgroundColor : style.getPropertyValue('--surface').trim(), inkColor: style.color };
      } catch { return null; }
    })), aborted]);
    clearTimeout(timeout);
    if (!rows || signal.aborted || !container.isConnected) return;
    rows = rows.filter(row => row && row.node.isConnected);
    if (!rows.length) return;
    const windRows = rows.filter(row => row.kind === 'row');
    windRows.forEach((row, index) => { row.rank = index / Math.max(1, windRows.length - 1); });
    const before = captureRemovalLayout(container);
    for (const row of rows) row.node.style.visibility = 'hidden';
    canvas.dataset.rows = String(rows.filter(row => row.kind === 'row').length); canvas.dataset.scrolls = String(rows.filter(row => row.kind === 'scroll').length); canvas.dataset.fragments = String(rows.reduce((sum, row) => sum + row.tiles.length, 0));
    document.body.append(canvas);
    const beginReflow = () => {
      render();
      const after = captureRemovalLayout(container);
      frameScroll = new Map();
      for (let node = container; node; node = node.parentElement) frameScroll.set(node, { top: node.scrollTop, left: node.scrollLeft });
      if (document.scrollingElement) frameScroll.set(document.scrollingElement, { top: document.scrollingElement.scrollTop, left: document.scrollingElement.scrollLeft });
      for (const [key, position] of after) {
        const previous = before.get(key);
        if (!previous) continue;
        const offset = previous.top - position.top;
        if (Math.abs(offset) > .5) {
          const animation = position.node.animate([{ transform: `translateY(${offset}px)` }, { transform: 'translateY(0)' }], { duration: rows.some(row => row.kind === 'row') ? reflowMs : 550, easing: 'cubic-bezier(.22,1,.36,1)' });
          animation.id = 'batch-removal-reflow'; animations.push(animation);
        }
      }
    };
    if (!await wind(canvas, rows, viewport, signal, beginReflow) || !container.isConnected) return;
    canvas.remove();
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  } catch {
    // A cosmetic snapshot or animation failure cannot change the worker's verified result.
  } finally {
    clearTimeout(timeout); cancel(); canvas.remove(); canvas.width = 0; canvas.height = 0;
    for (const row of rows || []) { if (!row) continue; row.node.style.visibility = row.visibility; row.source.width = 0; row.source.height = 0; }
  }
}
