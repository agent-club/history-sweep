// This decorative effect is independent of the looping product walkthrough.
export function initializePixelSweep({canvas, button, reducedMotion}) {
  const context = canvas.getContext('2d');
  if (!context) { canvas.hidden = true; button.hidden = true; return {renderLanguage() {}}; }
  const cycle = 7200;
  const art = canvas.parentElement.querySelector('.sweep-art');
  let rimPixels = [];
  let emitters = [];
  let width = 0;
  let height = 0;
  let elapsed = 2400;
  let frame = 0;
  let previousTime;
  let lastDraw = 0;
  let visible = false;
  let pausedByUser = false;
  let seed = 3817;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const particles = Array.from({length: 840}, () => ({
    phase: random(), source: random(), drift: random(), size: 1 + random() * 2,
    opacity: 0.3 + random() * 0.5, depth: random(),
  }));

  function mapEmitters() {
    if (!art.naturalWidth) return;
    const scale = Math.max(width / art.naturalWidth, height / art.naturalHeight);
    const position = getComputedStyle(art).objectPosition.split(' ').map(value => parseFloat(value) / 100);
    const offsetX = (width - art.naturalWidth * scale) * position[0];
    const offsetY = (height - art.naturalHeight * scale) * position[1];
    const bounds = canvas.getBoundingClientRect();
    const film = canvas.parentElement.querySelector('.film-window').getBoundingClientRect();
    // Use the same cover transform as the raster, including the mobile crop.
    emitters = rimPixels.map(point => ({...point, x: point.x * scale + offsetX, y: point.y * scale + offsetY}))
      .filter(point => point.x >= 0 && point.x < width && point.y >= 0 && point.y < height)
      .filter(point => point.x < film.left - bounds.left || point.x > film.right - bounds.left
        || point.y < film.top - bounds.top || point.y > film.bottom - bounds.top);
  }

  function readRimPixels() {
    const source = document.createElement('canvas');
    source.width = art.naturalWidth;
    source.height = art.naturalHeight;
    const sourceContext = source.getContext('2d', {willReadFrequently: true});
    sourceContext.drawImage(art, 0, 0);
    const pixels = sourceContext.getImageData(0, 0, source.width, source.height).data;
    const light = (x, y) => pixels[(y * source.width + x) * 4];
    rimPixels = [];
    for (let y = 3; y < source.height - 3; y += 3) {
      for (let x = 3; x < source.width - 3; x += 3) {
        if (light(x, y) < 105) continue;
        const dx = light(x + 3, y) - light(x - 3, y);
        const dy = light(x, y + 3) - light(x, y - 3);
        const length = Math.hypot(dx, dy);
        if (length < 12) continue;
        rimPixels.push({x, y, nx: -dx / length, ny: -dy / length});
      }
    }
    mapEmitters();
    draw(reducedMotion.matches ? 2400 : elapsed);
  }

  function draw(time) {
    context.clearRect(0, 0, width, height);
    if (!emitters.length) return;
    // Individual lifetimes fade out before wrapping, so the 7.2s cycle has no reset flash.
    const count = width < 760 ? 320 : particles.length;
    for (let index = 0; index < count; index++) {
      const particle = particles[index];
      const age = ((time / cycle + particle.phase) % 1 + 1) % 1;
      const entrance = Math.min(age / 0.16, 1);
      const exit = Math.min((1 - age) / 0.25, 1);
      const origin = emitters[Math.floor(particle.source * emitters.length)];
      const spread = width < 760 ? 0.55 : 1;
      const along = age * (30 + particle.drift * 58) * spread;
      const away = age ** 1.8 * (12 + particle.depth * 36) * spread;
      // Tangential motion follows the rim; its dark-facing normal peels pixels off it.
      const x = origin.x - origin.ny * along + origin.nx * away;
      const y = origin.y + origin.nx * along + origin.ny * away;
      const size = particle.size * (1 - age * 0.4);
      context.globalAlpha = entrance * exit * particle.opacity;
      context.fillStyle = '#e0e0dc';
      context.fillRect(Math.round(x), Math.round(y), size, size);
      if (particle.depth > .88 && age > .15 && age < .85) {
        const length = Math.sin(age * Math.PI) * (4 + particle.drift * 9) * spread;
        context.globalAlpha *= .32;
        context.strokeStyle = '#e6e8e0';
        context.lineWidth = .65;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + origin.ny * length, y - origin.nx * length);
        context.stroke();
      }
    }
    context.globalAlpha = 1;
  }

  function animate(time) {
    if (previousTime !== undefined) elapsed = (elapsed + Math.min(time - previousTime, 50)) % cycle;
    previousTime = time;
    if (time - lastDraw >= 1000 / 30) { draw(elapsed); lastDraw = time; }
    frame = requestAnimationFrame(animate);
  }

  function renderLanguage() {
    const zh = document.documentElement.lang === 'zh-CN';
    button.textContent = pausedByUser ? (zh ? '继续背景动效' : 'Resume background')
      : (zh ? '暂停背景动效' : 'Pause background');
    button.setAttribute('aria-pressed', String(pausedByUser));
    button.hidden = reducedMotion.matches;
  }

  function reconcile() {
    cancelAnimationFrame(frame);
    frame = 0;
    previousTime = undefined;
    const running = visible && !document.hidden && document.documentElement.dataset.introActive !== 'true' && !pausedByUser && !reducedMotion.matches;
    canvas.dataset.motion = reducedMotion.matches ? 'reduced' : running ? 'running' : 'paused';
    if (reducedMotion.matches) draw(2400);
    else if (running) frame = requestAnimationFrame(animate);
    renderLanguage();
  }

  new ResizeObserver(([entry]) => {
    width = entry.contentRect.width;
    height = entry.contentRect.height;
    const density = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * density);
    canvas.height = Math.round(height * density);
    context.setTransform(density, 0, 0, density, 0, 0);
    mapEmitters();
    draw(reducedMotion.matches ? 2400 : elapsed);
  }).observe(canvas);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting && entry.intersectionRatio >= 0.2;
    reconcile();
  }, {threshold: 0.2}).observe(canvas);
  button.addEventListener('click', () => { pausedByUser = !pausedByUser; reconcile(); });
  document.addEventListener('visibilitychange', reconcile);
  new MutationObserver(reconcile).observe(document.documentElement, {attributes: true, attributeFilter: ['data-intro-active']});
  reducedMotion.addEventListener('change', reconcile);
  if (art.complete && art.naturalWidth) readRimPixels();
  else art.addEventListener('load', readRimPixels, {once: true});
  reconcile();
  return {renderLanguage};
}
