const dialog = document.getElementById('question-intro');
const canvas = document.getElementById('intro-pixels');
const context = canvas.getContext('2d');
const ribbon = document.getElementById('intro-ribbon');
const homeRibbon = document.querySelector('.sweep-art');
const skip = document.getElementById('intro-skip');
const questions = [...dialog.querySelectorAll('[data-intro-question]')];
const answer = dialog.querySelector('.intro-answer');
const progress = [...dialog.querySelectorAll('.intro-progress i')];
const counter = dialog.querySelector('.intro-counter');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const questionDuration = 3000;
const starts = [700, 3700, 6700];
const gatherAt = starts[2] + questionDuration;
const dissolveAt = gatherAt + 1100;
const endAt = dissolveAt + 3000;
let textParticles = [];
let textCaptured = false;
let questionEdges = [];
let typedLines = [];
let typingCursor;
let displayFontSettled = false;
let rimPixels = [];
let targets = [];
let ribbonBounds;
let ribbonOpacity = 1;
let width = 0;
let height = 0;
let elapsed = 0;
let previousTime;
let frame = 0;
let currentQuestion = -1;
let trigger;
let exiting = false;
const clamp = value => Math.max(0, Math.min(1, value));
const smooth = value => value * value * (3 - 2 * value);
const motes = Array.from({length: 680}, (_, index) => ({
  seed: (Math.imul(index + 1, 1597334677) >>> 0) / 4294967295,
  phase: ((index * 2654435761) >>> 0) / 4294967295,
}));

function readRibbon() {
  const source = document.createElement('canvas');
  source.width = homeRibbon.naturalWidth;
  source.height = homeRibbon.naturalHeight;
  const sample = source.getContext('2d', {willReadFrequently: true});
  sample.drawImage(homeRibbon, 0, 0);
  const pixels = sample.getImageData(0, 0, source.width, source.height).data;
  const light = (x, y) => pixels[(y * source.width + x) * 4];
  rimPixels = [];
  for (let y = 5; y < source.height - 5; y += 5) for (let x = 5; x < source.width - 5; x += 5) {
    if (light(x, y) < 105) continue;
    const dx = light(x + 3, y) - light(x - 3, y);
    const dy = light(x, y + 3) - light(x, y - 3);
    const length = Math.hypot(dx, dy);
    if (length >= 12) rimPixels.push({x, y, nx: -dx / length, ny: -dy / length});
  }
  if (dialog.open) resize();
}

function resize() {
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  const density = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * density);
  canvas.height = Math.round(height * density);
  context?.setTransform(density, 0, 0, density, 0, 0);
  ribbonBounds = homeRibbon.getBoundingClientRect();
  const style = getComputedStyle(homeRibbon);
  ribbonOpacity = Number(style.opacity);
  Object.assign(ribbon.style, {left: `${ribbonBounds.left}px`, top: `${ribbonBounds.top}px`,
    width: `${ribbonBounds.width}px`, height: `${ribbonBounds.height}px`, objectPosition: style.objectPosition});
  const scale = Math.max(ribbonBounds.width / homeRibbon.naturalWidth, ribbonBounds.height / homeRibbon.naturalHeight);
  const position = style.objectPosition.split(' ').map(value => parseFloat(value) / 100);
  const offsetX = ribbonBounds.left + (ribbonBounds.width - homeRibbon.naturalWidth * scale) * position[0];
  const offsetY = ribbonBounds.top + (ribbonBounds.height - homeRibbon.naturalHeight * scale) * position[1];
  const film = document.querySelector('.film-window').getBoundingClientRect();
  // The destination is the real homepage rim in viewport coordinates, not a separate illustration.
  targets = rimPixels.map(point => ({...point, x: point.x * scale + offsetX, y: point.y * scale + offsetY}))
    .filter(point => point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height)
    .filter(point => point.x < film.left || point.x > film.right || point.y < film.top || point.y > film.bottom);
  canvas.dataset.ribbonTargets = String(targets.length);
  if (currentQuestion >= 0 && currentQuestion < 3 && !reducedMotion.matches) {
    measureTyping();
    updateTyping(elapsed);
  }
  if (textCaptured) captureText();
  draw(dialog.dataset.phase === 'static' ? 2400 : elapsed);
}

function prepareLines() {
  for (const question of questions) {
    const paragraph = question.querySelector('p');
    if (paragraph.querySelector('.intro-line')) continue;
    const lines = paragraph.innerHTML.split(/<br\s*\/?\s*>/i);
    paragraph.replaceChildren(...lines.map(text => {
      const line = document.createElement('span');
      line.className = 'intro-line';
      const ink = document.createElement('span');
      ink.textContent = text;
      line.append(ink);
      return line;
    }));
  }
}

function measureTyping() {
  typedLines = [...questions[currentQuestion].querySelectorAll('.intro-line > span')].map((line, index) => {
    const node = line.firstChild;
    const range = document.createRange();
    let offset = 0;
    const glyphs = [...node.textContent].map(character => {
      range.setStart(node, offset);
      offset += character.length;
      range.setEnd(node, offset);
      return range.getBoundingClientRect();
    });
    return {line, glyphs, box: line.getBoundingClientRect(), start: index === 0 ? 80 : 1150,
      duration: index === 0 ? 750 : 950, count: -1};
  });
}

function updateTyping(time) {
  typingCursor = undefined;
  if (currentQuestion < 0 || currentQuestion > 2) return;
  const age = time - starts[currentQuestion];
  for (const [index, entry] of typedLines.entries()) {
    const {line, glyphs, box, start, duration} = entry;
    const count = Math.ceil(clamp((age - start) / duration) * glyphs.length);
    const glyph = glyphs[Math.max(0, count - 1)];
    if (count !== entry.count) {
      // Clip the unchanged text at real glyph boundaries; line wrapping and accessibility stay intact.
      const top = Math.max(0, glyph.top - box.top);
      const bottom = glyph.bottom - box.top + 2;
      const right = glyph.right - box.left + 1;
      line.style.clipPath = count === 0 ? 'inset(0 100% 0 0)' : count === glyphs.length ? 'none'
        : `polygon(0 0,100% 0,100% ${top}px,${right}px ${top}px,${right}px ${bottom}px,0 ${bottom}px)`;
      entry.count = count;
    }
    const nextStart = typedLines[index + 1]?.start ?? Infinity;
    if (age >= start && age < nextStart) {
      typingCursor = {x: count ? glyph.right + 4 : glyph.left, y: glyph.top + glyph.height * .16,
        height: glyph.height * .69, alpha: count < glyphs.length ? .85 : .35 + .45 * Math.sin(age / 260) ** 2};
    }
  }
  const exitAt = (starts[currentQuestion + 1] ?? gatherAt) - starts[currentQuestion] - 190;
  if (age >= exitAt) typingCursor = undefined;
}

function captureText() {
  if (!context || !targets.length) return;
  // Rasterize the visible localized glyphs at their DOM positions, including wrapping and tracking.
  const mask = document.createElement('canvas');
  mask.width = Math.ceil(width);
  mask.height = Math.ceil(height);
  const ink = mask.getContext('2d', {willReadFrequently: true});
  ink.fillStyle = '#f0efec';
  for (const line of dialog.querySelectorAll('.intro-line > span')) {
    const style = getComputedStyle(line);
    ink.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const node = line.firstChild;
    const range = document.createRange();
    let offset = 0;
    for (const character of node.textContent) {
      range.setStart(node, offset);
      offset += character.length;
      range.setEnd(node, offset);
      const bounds = range.getBoundingClientRect();
      const metrics = ink.measureText(character);
      const ascent = metrics.fontBoundingBoxAscent;
      const descent = metrics.fontBoundingBoxDescent;
      ink.fillText(character, bounds.left, bounds.top + (bounds.height - ascent - descent) / 2 + ascent);
    }
  }
  const pixels = ink.getImageData(0, 0, mask.width, mask.height).data;
  const step = width < 760 ? 2 : 3;
  textParticles = [];
  for (let y = 0; y < mask.height; y += step) for (let x = 0; x < mask.width; x += step) {
    const alpha = pixels[(y * mask.width + x) * 4 + 3] / 255;
    if (alpha < .15) continue;
    const seed = ((Math.imul(x + 1, 73856093) ^ Math.imul(y + 1, 19349663)) >>> 0) / 4294967295;
    let destination;
    let distance = Infinity;
    // Local candidate sampling spreads the dust along the actual rim without crossing the entire screen.
    for (let index = 0; index < 48; index++) {
      const candidate = targets[(Math.floor(seed * targets.length) + index * 137) % targets.length];
      const score = (candidate.x - x - (seed - .5) * 240) ** 2 + (candidate.y - y) ** 2 * .6;
      if (score < distance) { destination = candidate; distance = score; }
    }
    textParticles.push({x, y, alpha, seed, destination, size: step,
      delay: x / width * 260 + seed * 280, duration: 1450 + seed * 350});
  }
  canvas.dataset.textParticles = String(textParticles.length);
  canvas.dataset.textSource = 'localized-glyphs';
  textCaptured = true;
}

function drawText(time) {
  let arriving = 0;
  for (const particle of textParticles) {
    const {x, y, seed, destination, alpha, size} = particle;
    const travel = clamp((time - dissolveAt - particle.delay) / particle.duration);
    const t = travel * travel * (3 - 2 * travel);
    const rest = 1 - t;
    const cx = x + 90 + seed * 100;
    const cy = y - 90 - seed * 90;
    const dx = destination.x + destination.ny * 160;
    const dy = destination.y - destination.nx * 160;
    const px = rest ** 3 * x + 3 * rest ** 2 * t * cx + 3 * rest * t ** 2 * dx + t ** 3 * destination.x;
    const py = rest ** 3 * y + 3 * rest ** 2 * t * cy + 3 * rest * t ** 2 * dy + t ** 3 * destination.y;
    if (travel >= .95) arriving++;
    context.globalAlpha = alpha * (1 - smooth(clamp((travel - .83) / .17)));
    context.fillStyle = travel > .1 ? '#eeeeeb' : '#f0efec';
    const edge = size * (1 - t * .72);
    context.fillRect(px, py, edge, edge);
    if (travel > .08 && travel < .96 && seed > .72) {
      const vx = rest ** 2 * (cx - x) + 2 * rest * t * (dx - cx) + t ** 2 * (destination.x - dx);
      const vy = rest ** 2 * (cy - y) + 2 * rest * t * (dy - cy) + t ** 2 * (destination.y - dy);
      const velocity = Math.hypot(vx, vy);
      const length = Math.sin(travel * Math.PI) * (5 + seed * 18);
      context.globalAlpha *= .32;
      context.strokeStyle = '#e4e6df';
      context.lineWidth = .65;
      context.beginPath();
      context.moveTo(px, py);
      context.lineTo(px - vx / velocity * length, py - vy / velocity * length);
      context.stroke();
    }
    // A few fragments shed sparks tangent to the sampled rim as they arrive.
    const impact = (time - dissolveAt - particle.delay - particle.duration) / 620;
    if (seed > .94 && impact > 0 && impact < 1) {
      const envelope = Math.sin(Math.PI * impact) * (1 - impact);
      for (let spark = 0; spark < 3; spark++) {
        const along = (spark - 1) * (18 + seed * 32) * impact;
        const away = Math.sin(impact * Math.PI / 2) * (6 + spark * 5);
        const sx = destination.x - destination.ny * along + destination.nx * away;
        const sy = destination.y + destination.nx * along + destination.ny * away;
        context.globalAlpha = envelope * .6;
        context.fillRect(sx, sy, spark === 1 ? 1.6 : .8, .8);
      }
    }
  }
  canvas.dataset.arrivedParticles = String(arriving);
  context.globalAlpha = 1;
}

function drawQuestionBurst(time) {
  if (currentQuestion < 0 || currentQuestion > 2) return;
  const age = (time - starts[currentQuestion]) / 1600;
  if (age < 0 || age > 1.75) return;
  const count = width < 760 ? 100 : 190;
  context.strokeStyle = '#f1f2ea';
  for (const [lineIndex, edge] of questionEdges.entries()) {
    const typed = typedLines[lineIndex];
    if (!typed || typed.count <= 0) continue;
    const typedWidth = typed.glyphs[typed.count - 1].right - edge.left;
    const direction = (currentQuestion + lineIndex) % 2 ? -1 : 1;
    for (let index = 0; index < count; index++) {
      const mote = motes[index];
      const life = clamp(age - lineIndex * .52 - mote.phase * .16);
      if (life <= 0 || life >= 1) continue;
      const distance = 1 - (1 - life) ** 2;
      const x = edge.left + mote.phase * typedWidth + direction * distance * (30 + mote.seed * 135);
      const y = edge.bottom + 4 + distance * (8 + mote.seed * 32) + Math.sin(life * Math.PI) * (mote.phase - .5) * 28;
      const opacity = Math.sin(Math.PI * life) ** 1.5 * (.16 + mote.seed * .4);
      context.globalAlpha = opacity;
      context.fillStyle = '#e6e8e0';
      const size = .65 + mote.seed * 1.1;
      context.fillRect(x, y, size, size);
      if (mote.seed > .86) {
        context.globalAlpha = opacity * .35;
        context.lineWidth = .55;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x - direction * (4 + 12 * Math.sin(life * Math.PI)), y - 1);
        context.stroke();
      }
    }
  }
  context.globalAlpha = 1;
}

function drawBackdrop(time) {
  const entrance = smooth(clamp(time / 850));
  const exit = 1 - smooth(clamp((time - dissolveAt - 1450) / 1100));
  const visibility = entrance * exit;
  const atmosphere = context.createRadialGradient(width * .3, height * .28, 0,
    width * .45, height * .4, Math.max(width, height) * .7);
  atmosphere.addColorStop(0, 'rgba(160,170,162,.075)');
  atmosphere.addColorStop(.55, 'rgba(130,138,132,.025)');
  atmosphere.addColorStop(1, 'rgba(130,138,132,0)');
  context.globalAlpha = visibility;
  context.fillStyle = atmosphere;
  context.fillRect(0, 0, width, height);

  // Broad filaments occupy the empty upper/lower field and contract before the homepage reveal.
  const contraction = smooth(clamp((time - gatherAt - 350) / 2000));
  const filament = context.createLinearGradient(0, height, width, 0);
  filament.addColorStop(0, 'rgba(216,224,214,0)');
  filament.addColorStop(.22, 'rgba(216,224,214,.13)');
  filament.addColorStop(.6, 'rgba(216,224,214,.025)');
  filament.addColorStop(.82, 'rgba(216,224,214,.1)');
  filament.addColorStop(1, 'rgba(216,224,214,0)');
  context.strokeStyle = filament;
  context.globalAlpha = visibility * (1 - contraction);
  for (let lane = 0; lane < 4; lane++) {
    const shift = Math.sin(time / 11000 + lane * .6) * height * .025;
    context.lineWidth = lane === 0 ? 1 : .55;
    context.beginPath();
    context.moveTo(-width * .1, height * (.75 + lane * .035) + shift);
    context.bezierCurveTo(width * .17, height * (1.03 + lane * .035),
      width * .23, height * (.04 + lane * .04), width * 1.1, height * (.14 + lane * .032) + shift);
    context.stroke();
    context.beginPath();
    context.moveTo(-width * .1, height * (.23 + lane * .025) - shift);
    context.bezierCurveTo(width * .24, -height * .1, width * .67, height * (.49 + lane * .025),
      width * 1.1, height * (.04 + lane * .02) - shift);
    context.stroke();
  }

  const count = width < 760 ? 340 : motes.length;
  const rotation = -.22;
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  for (let index = 0; index < count; index++) {
    const mote = motes[index];
    const angle = (mote.phase + time / 95000 * (mote.seed > .5 ? 1 : -1)) * Math.PI * 2;
    const lane = index % 3;
    const rx = width * (.36 + lane * .105 + (mote.seed - .5) * .17);
    const ry = height * (.3 + lane * .06 + (mote.seed - .5) * .12);
    let x = width * .5 + Math.cos(angle) * rx * cosine - Math.sin(angle) * ry * sine;
    let y = height * .49 + Math.cos(angle) * rx * sine + Math.sin(angle) * ry * cosine;
    if (index % 4 === 0) {
      x = ((mote.phase + time / 180000) % 1) * width;
      y = mote.seed * height + Math.sin(time / 7000 + index) * 8;
    }
    // The center stays quiet enough for the questions; depth and motion live around it.
    const clearance = Math.hypot((x - width * .5) / (width * .42), (y - height * .48) / (height * .24));
    const readability = .15 + .85 * smooth(clamp((clearance - .5) / .65));
    const join = smooth(clamp((time - dissolveAt + 300 - mote.seed * 300) / 2200));
    const destination = targets.length ? targets[Math.floor(mote.phase * targets.length)] : null;
    if (destination) {
      x += (destination.x - x) * join + Math.sin(join * Math.PI) * destination.nx * 45;
      y += (destination.y - y) * join + Math.sin(join * Math.PI) * destination.ny * 45;
    }
    const shimmer = .7 + .3 * Math.sin(time / 1400 + index * 1.7);
    const alpha = visibility * readability * shimmer * (.13 + mote.seed * .37);
    const size = .65 + mote.seed * (index % 9 === 0 ? 1.2 : .65);
    context.globalAlpha = alpha;
    context.fillStyle = '#d9ded7';
    context.fillRect(x, y, size, size);
    if (index % 11 === 0) {
      context.globalAlpha = alpha * .18;
      context.beginPath();
      context.arc(x + size / 2, y + size / 2, size * 2.8, 0, Math.PI * 2);
      context.fill();
    }
    if (mote.seed > .84 && index % 4 !== 0) {
      const tx = -Math.sin(angle) * rx * cosine - Math.cos(angle) * ry * sine;
      const ty = -Math.sin(angle) * rx * sine + Math.cos(angle) * ry * cosine;
      const length = Math.hypot(tx, ty);
      context.globalAlpha = alpha * .4;
      context.strokeStyle = '#cbd2c9';
      context.lineWidth = .6;
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x - tx / length * 6 * (1 - join), y - ty / length * 6 * (1 - join));
      context.stroke();
    }
  }
  context.globalAlpha = 1;
}

function draw(time) {
  if (!context) return;
  context.clearRect(0, 0, width, height);
  if (!ribbonBounds) return;
  const align = smooth(clamp((time - 300) / (gatherAt - 500)));
  const reveal = smooth(clamp((time - dissolveAt - 1350) / 1300));
  const scale = 1 + .09 * (1 - align);
  const angle = -.045 * (1 - align);
  const a = Math.cos(angle) * scale;
  const b = Math.sin(angle) * scale;
  const c = -b;
  const d = a;
  const ox = ribbonBounds.width / 2;
  const oy = ribbonBounds.height * .18;
  const e = ox - a * ox - c * oy;
  const f = oy - b * ox - d * oy - 38 * (1 - align);
  ribbon.style.transform = `matrix(${a},${b},${c},${d},${e},${f})`;
  ribbon.style.opacity = ribbonOpacity * (.65 + .35 * smooth(clamp(time / 800))) * (1 - reveal);
  dialog.style.setProperty('--intro-cover', 1 - reveal);
  dialog.style.setProperty('--intro-copy', 1 - clamp(reveal * 2.5));
  dialog.style.setProperty('--intro-ink', time >= dissolveAt && textCaptured ? 0 : 1);
  drawBackdrop(time);
  if (!targets.length) return;
  const count = width < 760 ? 280 : motes.length;
  for (let index = 0; index < count; index++) {
    const mote = motes[index];
    const origin = targets[Math.floor(mote.phase * targets.length)];
    const age = (time / 3400 + mote.phase) % 1;
    const join = smooth(clamp((time - dissolveAt - 600 - mote.seed * 180) / 1350));
    const along = age * (32 + mote.seed * 62) * (1 - join);
    const away = age ** 1.5 * (14 + mote.phase * 42) * (1 - join);
    const px = origin.x - ribbonBounds.left - origin.ny * along + origin.nx * away;
    const py = origin.y - ribbonBounds.top + origin.nx * along + origin.ny * away;
    const x = ribbonBounds.left + a * px + c * py + e;
    const y = ribbonBounds.top + b * px + d * py + f;
    const lifetime = join > 0 ? 1 : Math.min(age / .15, (1 - age) / .2, 1);
    context.globalAlpha = smooth(clamp(time / 700)) * lifetime * (.25 + mote.phase * .5)
      * (1 - smooth(clamp((time - dissolveAt - 1850) / 800)));
    context.fillStyle = '#e8e8df';
    context.beginPath();
    context.arc(x, y, (.6 + mote.seed * .7) * (1 - join * .65), 0, Math.PI * 2);
    context.fill();
    if (mote.seed > .88 && age > .2 && age < .8) {
      context.globalAlpha *= .25;
      context.strokeStyle = '#eef0e8';
      context.lineWidth = .6;
      const length = (4 + mote.seed * 7) * (1 - join);
      context.beginPath();
      context.moveTo(x, y);
      context.lineTo(x + origin.ny * length, y - origin.nx * length);
      context.stroke();
    }
  }
  context.globalAlpha = 1;
  if (!reducedMotion.matches) drawQuestionBurst(time);
  if (typingCursor && currentQuestion >= 0 && currentQuestion < 3 && !reducedMotion.matches) {
    context.globalAlpha = typingCursor.alpha;
    context.fillStyle = '#d9ded7';
    context.fillRect(typingCursor.x, typingCursor.y, width < 760 ? 1 : 1.5, typingCursor.height);
    context.globalAlpha = 1;
  }
  if (time >= dissolveAt && textCaptured) drawText(time);
}

function showQuestion(index) {
  if (index === currentQuestion) return;
  currentQuestion = index;
  for (const question of questions) {
    for (const animation of question.getAnimations({subtree: true})) animation.cancel();
    for (const line of question.querySelectorAll('.intro-line > span')) line.style.removeProperty('clip-path');
    question.hidden = index === 3 ? false : question.dataset.introQuestion !== String(index);
  }
  typedLines = [];
  typingCursor = undefined;
  answer.hidden = true;
  if (index < 0) return;
  dialog.dataset.phase = index === 3 ? 'gather' : 'questions';
  questionEdges = index === 3 ? [] : [...questions[index].querySelectorAll('.intro-line > span')].map(line => {
    const range = document.createRange();
    range.selectNodeContents(line.firstChild);
    return range.getBoundingClientRect();
  });
  if (index < 3) {
    measureTyping();
    updateTyping(elapsed);
  }
  const visible = index === 3 ? questions : [];
  for (const [questionIndex, question] of visible.entries()) {
    for (const [lineIndex, line] of [...question.querySelectorAll('.intro-line > span')].entries()) {
      line.animate([
        {opacity: 0, transform: 'translate3d(0,22px,0)', offset: 0},
        {opacity: 1, transform: 'translate3d(0,0,0)', offset: 1},
      ], {duration: 460, delay: questionIndex * 65 + lineIndex * 35,
        easing: 'cubic-bezier(.16,1,.3,1)', fill: 'backwards'});
    }
  }
  if (index < 3) questions[index].animate([
    {opacity: 1, transform: 'translateX(0) scale(1)', clipPath: 'inset(0 0 0 0)'},
    {opacity: 0, transform: `translateX(${index % 2 ? 70 : -70}px) scale(.96)`, clipPath: `inset(0 ${index % 2 ? 0 : 100}% 0 ${index % 2 ? 100 : 0}%)`},
  ], {delay: index === 2 ? gatherAt - starts[2] - 190 : starts[index + 1] - starts[index] - 190,
    duration: 190, easing: 'cubic-bezier(.7,0,1,.4)', fill: 'forwards'});
  counter.textContent = `${String(Math.min(index + 1, 3)).padStart(2, '0')} / 03`;
}

function cleanup() {
  if (!dialog.open) return;
  cancelAnimationFrame(frame);
  textParticles = [];
  typedLines = [];
  typingCursor = undefined;
  for (const animation of dialog.getAnimations({subtree: true})) animation.cancel();
  dialog.close();
  delete document.documentElement.dataset.introActive;
  // Automatic playback has no invoking control; let the dialog restore the page's original focus.
  const returnTo = trigger?.isConnected && trigger !== document.body ? trigger : null;
  returnTo?.focus({preventScroll: true});
}

function finish(animate = true) {
  if (!dialog.open) return;
  if (!animate || reducedMotion.matches) { cleanup(); return; }
  if (exiting) return;
  exiting = true;
  cancelAnimationFrame(frame);
  const closingAnimation = dialog.animate([{opacity: 1}, {opacity: 0}], {duration: 380, easing: 'ease-out', fill: 'both'});
  closingAnimation.finished.then(cleanup).catch(() => {});
}

function tick(time) {
  if (!dialog.open || exiting) return;
  // Measure the typing and dissolve against the final font, so no glyphs jump during playback.
  if (document.documentElement.lang === 'zh-CN' && !displayFontSettled) {
    previousTime = undefined;
    frame = requestAnimationFrame(tick);
    return;
  }
  if (previousTime !== undefined) elapsed += Math.min(time - previousTime, 50);
  previousTime = time;
  const index = elapsed >= gatherAt ? 3 : starts.findLastIndex(start => elapsed >= start);
  showQuestion(index);
  updateTyping(elapsed);
  if (elapsed >= dissolveAt - 240 && !textCaptured) captureText();
  if (elapsed >= dissolveAt) dialog.dataset.phase = 'handoff';
  draw(elapsed);
  progress.forEach((bar, index) => bar.style.setProperty('--intro-progress', clamp((elapsed - starts[index]) / questionDuration)));
  if (elapsed >= endAt) { cleanup(); return; }
  frame = requestAnimationFrame(tick);
}

function openIntro(event) {
  if (dialog.open) return;
  trigger = event?.currentTarget || document.activeElement;
  exiting = false;
  elapsed = 0;
  previousTime = undefined;
  currentQuestion = -2;
  textCaptured = false;
  textParticles = [];
  typedLines = [];
  typingCursor = undefined;
  delete canvas.dataset.textParticles;
  delete canvas.dataset.textSource;
  delete canvas.dataset.arrivedParticles;
  prepareLines();
  for (const line of dialog.querySelectorAll('.intro-line > span')) line.style.removeProperty('clip-path');
  dialog.style.setProperty('--intro-cover', 1);
  dialog.style.setProperty('--intro-copy', 1);
  dialog.style.setProperty('--intro-ink', 1);
  document.documentElement.dataset.introActive = 'true';
  dialog.showModal();
  resize();
  const zh = document.documentElement.lang === 'zh-CN';
  skip.textContent = reducedMotion.matches ? (zh ? '进入官网 ↗' : 'Continue ↗') : (zh ? '跳过开场 ↗' : 'Skip opening ↗');
  if (reducedMotion.matches) {
    dialog.dataset.phase = 'static';
    for (const question of questions) question.hidden = false;
    answer.hidden = true;
    draw(2400);
  } else {
    dialog.dataset.phase = 'flowing';
    showQuestion(-1);
    progress.forEach(bar => bar.style.setProperty('--intro-progress', 0));
    frame = requestAnimationFrame(tick);
  }
}

skip.addEventListener('click', () => finish());
dialog.addEventListener('cancel', event => { event.preventDefault(); finish(); });
for (const button of document.querySelectorAll('[data-intro-replay]')) button.addEventListener('click', openIntro);
new ResizeObserver(() => { if (dialog.open) resize(); }).observe(canvas);
new ResizeObserver(() => { if (dialog.open) resize(); }).observe(homeRibbon);
document.addEventListener('visibilitychange', () => { previousTime = undefined; });
reducedMotion.addEventListener('change', () => { if (dialog.open) finish(false); });
const settleDisplayFont = () => {
  displayFontSettled = true;
  if (dialog.open) resize();
};
document.fonts.load('400 48px "Sweep Display SC"', '记录').then(settleDisplayFont, settleDisplayFont);
if (homeRibbon.complete && homeRibbon.naturalWidth) readRibbon();
else homeRibbon.addEventListener('load', readRibbon, {once: true});
// Anchor visits go straight to their section. The opening uses no persisted preference.
if (!location.hash && !reducedMotion.matches) openIntro();
