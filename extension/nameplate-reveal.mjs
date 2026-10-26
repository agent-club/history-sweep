// Native counterpart of approved Remotion 04. One timeline, material-specific light.
const finishes = {
  obsidian: ['111 222 255', '160 190 244', '5 7 13', 1, .6],
  ivory: ['218 190 143', '246 224 185', '23 21 16', .55, .22],
  aurora: ['172 153 239', '130 222 209', '13 12 27', .85, .4],
  gold: ['235 193 112', '255 226 170', '23 17 8', .8, .5],
};
const clamp = x => Math.max(0, Math.min(1, x));
// Invert cubic-bezier(.22, 1, .36, 1), matching the frame-based preview.
function ease(x) {
  x = clamp(x);
  let low = 0, high = 1;
  for (let i = 0; i < 12; i++) {
    const t = (low + high) / 2;
    const bx = 3 * (1 - t) ** 2 * t * .22 + 3 * (1 - t) * t ** 2 * .36 + t ** 3;
    if (bx < x) low = t; else high = t;
  }
  return 1 - (1 - (low + high) / 2) ** 3;
}
const fade = (t, start, end) => clamp((t - start) / (end - start));
const move = (t, start, end, from, to) => from + (to - from) * ease((t - start) / (end - start));

export function createNameplateReveal(section, reduced) {
  const dialog = section.closest('dialog');
  const stage = section.querySelector('.np-stage');
  const object = section.querySelector('.np-object');
  const buttons = [...section.querySelectorAll('.np-control, .np-collect'), stage];
  const variant = section.dataset.variant;
  const [energy, secondary, background, intensity, glint] = finishes[variant];
  const notifyPhase = phase => dialog.dispatchEvent(new CustomEvent('history-sweep:nameplate-effect', { detail: { phase, material: variant, reduced: reduced.matches } }));
  dialog.dataset.material = variant;
  dialog.style.setProperty('--np-energy', energy);
  dialog.style.setProperty('--np-secondary', secondary);
  dialog.style.setProperty('--np-background', background);
  dialog.style.setProperty('--np-background-opacity', '1');
  delete dialog.dataset.collecting;
  const effects = document.createElement('span');
  effects.className = 'np-orbit-scene'; effects.setAttribute('aria-hidden', 'true');
  const make = name => { const node = document.createElement('span'); node.className = name; effects.append(node); return node; };
  const aura = make('np-reveal-aura');
  const rings = Array.from({ length: 3 }, () => make('np-orbit-ring'));
  const shocks = Array.from({ length: 3 }, () => make('np-shock-ring'));
  const flare = make('np-reveal-flare');
  const particles = Array.from({ length: 64 }, (_, i) => {
    const node = make('np-orbit-particle'); node.style.width = `${i % 3 + 1}px`; return node;
  });
  stage.prepend(effects);
  // Window-sized effects share the card's clock, so reopening cannot leave a second loop.
  const perimeter = document.createElement('span');
  perimeter.className = 'np-window-effects'; perimeter.setAttribute('aria-hidden', 'true');
  const rim = document.createElement('span'); rim.className = 'np-window-rim'; perimeter.append(rim);
  const haze = document.createElement('span'); haze.className = 'np-window-haze'; perimeter.append(haze);
  const sparks = Array.from({ length: 28 }, (_, i) => {
    const node = document.createElement('span'); node.className = 'np-window-spark';
    const side = i % 4, along = 8 + Math.floor(i / 4) * 14;
    node.style.left = `${side === 0 ? along : side === 1 ? 98 : side === 2 ? 100 - along : 2}%`;
    node.style.top = `${side === 0 ? 2 : side === 1 ? along : side === 2 ? 98 : 100 - along}%`;
    perimeter.append(node); return { node, side };
  });
  dialog.append(perimeter);
  function drawPerimeter(t, contraction = false) {
    const light = contraction ? (.35 + .4 * Math.sin(Math.PI * fade(t, 0, .95))) * (1 - fade(t, .18, .95)) : fade(t, .08, .7) * (1 - .65 * fade(t, 1.05, 2.25));
    perimeter.style.opacity = light * intensity;
    rim.hidden = contraction;
    sparks.forEach(({ node, side }, i) => {
      const progress = fade(t, contraction ? 0 : .4 + i % 7 * .04, contraction ? 1.05 : 1.8 + i % 3 * .12);
      const distance = contraction ? ease(progress) * 70 : Math.sin(progress * Math.PI) * (12 + i % 5 * 8);
      const direction = [[0, 1], [-1, 0], [0, -1], [1, 0]][side];
      node.style.transform = `translate(${direction[0] * distance}px, ${direction[1] * distance}px) scale(${1 + Math.sin(progress * Math.PI) * .7})`;
      node.style.opacity = Math.sin(progress * Math.PI) * (.5 + i % 3 * .2);
    });
  }
  // Rendering stops in the background; exclude that time so neither one-shot skips ahead.
  const lifecycle = new AbortController();
  let pausedAt = document.hidden ? performance.now() : null, pausedDuration = 0;
  const timelineNow = () => (pausedAt ?? performance.now()) - pausedDuration;
  const pauseTimeline = () => { pausedAt ??= performance.now(); };
  const resumeTimeline = () => {
    if (document.hidden || pausedAt === null) return;
    pausedDuration += performance.now() - pausedAt; pausedAt = null;
  };
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseTimeline(); else resumeTimeline(); }, { signal: lifecycle.signal });
  window.addEventListener('pagehide', pauseTimeline, { signal: lifecycle.signal });
  window.addEventListener('pageshow', resumeTimeline, { signal: lifecycle.signal });
  const started = timelineNow();
  let active = !reduced.matches;
  let collecting = false, collected, collectionStarted, collectionTransform;
  section.dataset.phase = active ? 'revealing' : 'settled';
  notifyPhase(section.dataset.phase);
  buttons.forEach(button => { button.disabled = active; });
  function finish() {
    active = false; section.dataset.phase = 'settled';
    buttons.forEach(button => { button.disabled = false; });
    object.style.opacity = ''; effects.remove();
    // Keep a static material glow while the card is open; only the entrance particles end.
    perimeter.style.opacity = .35 * intensity;
    sparks.forEach(({ node }) => { node.style.opacity = '0'; });
    notifyPhase('settled');
  }
  if (!active) finish();
  function finishCollection() {
    collecting = false; section.dataset.phase = 'collected';
    object.style.opacity = '0'; dialog.style.setProperty('--np-background-opacity', '0');
    effects.remove(); perimeter.remove(); collected?.(); collected = null;
  }
  return {
    get active() { return active || collecting; },
    collect() {
      if (collecting || reduced.matches) return Promise.resolve();
      active = false; collecting = true; collectionStarted = timelineNow();
      collectionTransform = object.style.transform;
      section.dataset.phase = 'collecting'; dialog.dataset.collecting = 'true';
      notifyPhase('collecting');
      buttons.forEach(button => { button.disabled = true; });
      stage.prepend(effects);
      dialog.append(perimeter);
      flare.style.opacity = '0';
      shocks.forEach(node => { node.style.opacity = '0'; });
      return new Promise(resolve => { collected = resolve; });
    },
    render() {
      if (collecting) {
        const t = (timelineNow() - collectionStarted) / 1000;
        if (reduced.matches || t >= 1.05) { finishCollection(); return true; }
        const gather = ease(fade(t, .08, .9)), vanish = 1 - fade(t, .75, 1.05);
        drawPerimeter(t, true);
        object.style.transform = `${collectionTransform} scale(${1 - gather * .98}) rotateZ(${-gather * 16}deg)`;
        object.style.opacity = 1 - fade(t, .4, .85);
        // Reveal the underlying workspace during the particle contraction, not after it.
        dialog.style.setProperty('--np-background-opacity', String(1 - fade(t, .08, .95)));
        aura.style.opacity = Math.sin(Math.PI * fade(t, 0, 1.05)) * intensity * .85;
        aura.style.transform = `translate(-50%, -50%) scale(${.85 - gather * .78})`;
        rings.forEach((node, i) => {
          node.style.opacity = fade(t, 0, .12) * vanish * intensity * (.8 - i * .17);
          node.style.transform = `translate(-50%, -50%) rotateZ(${i * 60 + t * 150}deg) rotateX(${62 + i * 9}deg) scale(${(.72 + i * .13) * (1 - gather) + .02})`;
        });
        particles.forEach((node, i) => {
          const angle = i * 2.39996 + gather * (i % 2 ? 1.4 : -.9);
          const radius = (110 + i % 11 * 16) * (1 - gather);
          node.style.transform = `translate(calc(-50% + ${Math.cos(angle) * radius}px), calc(-50% + ${Math.sin(angle) * radius * .62}px))`;
          node.style.opacity = fade(t, 0, .16) * vanish * (.35 + i % 5 * .14) * intensity;
        });
        return true;
      }
      if (!active) return false;
      if (reduced.matches) { finish(); return false; }
      const t = (timelineNow() - started) / 1000;
      if (t >= 2.25) { finish(); return false; }
      const charge = fade(t, 0, .78), release = fade(t, .78, 1.9);
      const burst = fade(t, .72, .86) * (1 - fade(t, .86, 1.7));
      const calm = 1 - fade(t, 1.65, 2.25);
      drawPerimeter(t);
      const scale = move(t, .25, 1.95, .15, 1);
      object.style.transform = `translate(-50%, -50%) translateY(${move(t, .45, 1.95, 65, 0)}px) rotateX(${move(t, .38, 1.9, 32, -5)}deg) rotateY(${move(t, .3, 1.95, -550, -9)}deg) rotateZ(${move(t, .5, 1.95, 12, -2)}deg) scale(${scale})`;
      object.style.opacity = fade(t, .55, .9);
      object.style.setProperty('--np-lx', `${move(t, 1.2, 2.25, 28, 84)}%`);
      object.style.setProperty('--np-ly', '24%');
      object.style.setProperty('--np-glint', glint);
      object.style.setProperty('--np-hue', `${move(t, 1.2, 2.25, 112, 227)}deg`);
      aura.style.opacity = (.22 + burst * .65) * intensity * calm;
      aura.style.transform = `translate(-50%, -50%) scale(${.5 + release * .65})`;
      rings.forEach((node, i) => {
        node.style.opacity = calm * intensity * (.8 - i * .15);
        node.style.transform = `translate(-50%, -50%) rotateZ(${i * 57 + t * (i % 2 ? -100 : 100)}deg) rotateX(${60 + i * 13}deg) scale(${.22 + charge * .85 + release * .15})`;
      });
      shocks.forEach((node, i) => {
        node.style.opacity = burst * (.55 - i * .1) * intensity;
        node.style.transform = `translate(-50%, -50%) scale(${move(t, .76 + i * .06, 1.85, .08, 1.5 + i * .35)})`;
      });
      flare.style.opacity = burst * .8 * intensity;
      particles.forEach((node, i) => {
        const angle = i * 2.39996;
        const radius = move(t, 0, .78, 300 + i % 9 * 23, 10) + move(t, .8, 1.8, 0, 350 + i % 7 * 55);
        node.style.transform = `translate(${Math.cos(angle) * radius}px, ${Math.sin(angle) * radius * .65}px)`;
        node.style.opacity = (.2 + i % 5 * .16) * fade(t, 0, .2) * (1 - fade(t, 1.1, 2)) * intensity;
      });
      return true;
    },
    destroy() { lifecycle.abort(); active = collecting = false; effects.remove(); perimeter.remove(); collected?.(); collected = null; delete dialog.dataset.collecting; },
  };
}
