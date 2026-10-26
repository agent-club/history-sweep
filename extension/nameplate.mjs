import { createNameplateReveal } from './nameplate-reveal.mjs';
import { NAMEPLATE_VARIANTS } from './nameplate-store.mjs';

export function nameplateDialog(t) {
  return `<dialog id="nameplateDialog" class="nameplate-dialog nameplate-reveal" aria-labelledby="nameplateTitle">
    <header class="nameplate-header"><div><h2 id="nameplateTitle" class="nameplate-heading">${t('nameplate')}</h2><p class="nameplate-intro">${t('nameplateIntro')}</p></div><button type="button" class="icon-button nameplate-close" aria-label="${t('nameplateClose')}"><img class="ui-icon" src="icons/ui/x.svg" alt="" aria-hidden="true"></button></header>
    <div class="nameplate-feedback"><p class="nameplate-status" role="status" aria-live="polite"></p><button type="button" class="quiet nameplate-retry" hidden>${t('nameplateRetry')}</button></div>
    <div class="nameplate-content" hidden></div>
  </dialog>`;
}

function cardMarkup(card, t) {
  const number = `${card.number.slice(0, 4)} · ${card.number.slice(4)}`;
  const date = card.issuedOn.replaceAll('-', '.');
  const title = t(`nameplate_${card.variant}_title`);
  const edition = String(NAMEPLATE_VARIANTS.indexOf(card.variant) + 1).padStart(3, '0');
  const detail = (label, value) => `<span class="np-detail"><span class="np-detail-label">${t(label)}</span><span class="np-detail-value">${value}</span></span>`;
  return `<section class="np-preview np-${card.variant}" data-variant="${card.variant}">
    <div class="np-caption"><strong>${t(`nameplate_${card.variant}`)}</strong><span>${t('nameplateGesture')}</span></div>
    <button type="button" class="np-stage" aria-label="${t('nameplateInteract', { title })}">
      <span class="np-shadow" aria-hidden="true"></span><span class="np-object">
        <span class="np-face np-front"><span class="np-art" aria-hidden="true"></span><span class="np-brand">HISTORY SWEEP</span><span class="np-edition">${edition}</span><span class="np-title">${title}</span><span class="np-subtitle">${t(`nameplate_${card.variant}_subtitle`)}</span><span class="np-number">${number}</span><span class="np-details">${detail('nameplateHolder', t('nameplateSelf'))}${detail('nameplateJoined', date)}${detail('nameplateValidity', t('nameplateForever'))}</span></span>
        <span class="np-face np-back" aria-hidden="true"><span class="np-brand">HISTORY SWEEP</span><span class="np-edition">${edition}</span><span class="np-back-wordmark">HISTORY<br>SWEEP</span><span class="np-back-motto">${title}</span><span class="np-back-rule"></span><span class="np-number">${number}</span><span class="np-back-validity">${t('nameplateSelf')} · ${t('nameplateForever')}</span></span>
      </span>
    </button>
    <div class="np-controls"><button type="button" class="np-control np-motion" aria-pressed="true"></button><button type="button" class="np-control np-flip"></button></div>
    <button type="button" class="np-collect"></button>
    <span class="np-footnote">${t('nameplateLocal')}</span><span class="np-screen-status" role="status" aria-live="polite"></span>
  </section>`;
}

export function mountNameplate(dialog, { t, read }) {
  const events = new AbortController();
  const content = dialog.querySelector('.nameplate-content');
  const feedback = dialog.querySelector('.nameplate-feedback');
  const status = dialog.querySelector('.nameplate-status');
  const retry = dialog.querySelector('.nameplate-retry');
  let request = 0;
  let motion;
  let first = false;
  let closed;
  const notifyHost = (open, effect = {}) => {
    if (document.body.dataset.presentation === 'modal' && window.parent !== window) {
      window.parent.postMessage({ type: 'history-sweep:nameplate', open, ...effect }, '*');
      // An already-injected host can outlive an extension update and only know preferences.
      window.parent.postMessage({ type: 'history-sweep:preferences', owner: 'nameplate', open: open || !!document.querySelector('#preferencesDialog')?.open }, '*');
    }
  };
  // The first reveal must escape the hidden, inert workspace during startup.
  document.body.append(dialog);
  const listen = (node, event, action) => node.addEventListener(event, action, { signal: events.signal });
  listen(dialog, 'history-sweep:nameplate-effect', event => notifyHost(true, event.detail));
  async function load(card) {
    const current = ++request;
    motion?.destroy(); motion = null;
    content.hidden = true; feedback.hidden = false; retry.hidden = true;
    status.textContent = t('nameplateLoading'); content.setAttribute('aria-busy', 'true');
    try {
      card = card || await read();
      if (current !== request || !dialog.open) return;
      content.innerHTML = cardMarkup(card, t);
      content.hidden = false; feedback.hidden = true;
      const collect = content.querySelector('.np-collect');
      collect.textContent = t(first ? 'nameplateCollect' : 'nameplateDone');
      motion = animateCard(content.querySelector('.np-preview'), t);
      collect.onclick = async () => {
        document.dispatchEvent(new Event('history-sweep:nameplate-collecting'));
        await motion.collect();
        if (current === request && dialog.open) dialog.close();
      };
    } catch {
      if (current !== request || !dialog.open) return;
      status.textContent = t('nameplateFailed'); retry.hidden = false;
    } finally { if (current === request) content.removeAttribute('aria-busy'); }
  }
  listen(dialog.querySelector('.nameplate-close'), 'click', () => dialog.close());
  listen(retry, 'click', () => load());
  listen(dialog, 'close', () => { request++; motion?.destroy(); motion = null; notifyHost(false); closed?.(); closed = null; });
  return {
    open(options = {}) {
      if (dialog.open) return;
      first = options.first === true;
      dialog.querySelector('.nameplate-heading').textContent = t(first ? 'nameplateWelcome' : 'nameplate');
      const completion = new Promise(resolve => { closed = resolve; });
      dialog.style.setProperty('--np-background-opacity', '1');
      dialog.showModal(); notifyHost(true); void load(options.card);
      return completion;
    },
    destroy() { request++; motion?.destroy(); events.abort(); dialog.remove(); notifyHost(false); closed?.(); },
  };
}

function animateCard(section, t) {
  const events = new AbortController();
  const listen = (node, event, action) => node.addEventListener(event, action, { signal: events.signal });
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const object = section.querySelector('.np-object');
  const stage = section.querySelector('.np-stage');
  const front = section.querySelector('.np-front');
  const back = section.querySelector('.np-back');
  const shadow = section.querySelector('.np-shadow');
  const motion = section.querySelector('.np-motion');
  const flipButton = section.querySelector('.np-flip');
  const live = section.querySelector('.np-screen-status');
  const effects = document.createElement('span'); effects.className = 'np-effects'; effects.setAttribute('aria-hidden', 'true');
  const atmosphere = document.createElement('span'); atmosphere.className = 'np-atmosphere';
  for (const className of ['np-halo', 'np-halo np-halo-secondary']) {
    const halo = document.createElement('span'); halo.className = className; atmosphere.append(halo);
  }
  for (const [x, y, size, duration, delay] of [[16, -5, 4, 8, -2], [88, -3, 3, 10, -6], [104, 59, 4, 9, -4], [72, 105, 3, 11, -8], [-5, 76, 3, 9, -1]]) {
    const glare = document.createElement('span'); glare.className = 'np-glare';
    glare.style.cssText = `--np-sx:${x}%;--np-sy:${y}%;--np-size:${size}px;--np-duration:${duration}s;--np-delay:${delay}s`;
    atmosphere.append(glare);
  }
  effects.append(atmosphere); stage.prepend(effects);
  for (let layer = 0; layer < 10; layer++) {
    const edge = document.createElement('span'); edge.className = 'np-edge'; edge.setAttribute('aria-hidden', 'true');
    edge.style.transform = `translateZ(${-3 + layer * 6 / 9}px)`; object.prepend(edge);
  }
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const hover = { inside: false, x: 0, y: 0, amount: 0, tiltX: 0, tiltY: 0, lightX: 0, lightY: 0 };
  let yaw = -9, pitch = -5, velocityX = 0, velocityY = 0, turnTo = null, idleUntil = 0;
  let pointer = null, lastX, lastY, startX, startY, lastMove, moved = false, suppressClick = false;
  let rotating = !reduced.matches, frame = 0, previous = 0, destroyed = false;
  let visibleFace;
  const reveal = createNameplateReveal(section, reduced);
  function clearHover(immediate = false) {
    hover.inside = false; hover.x = hover.y = 0;
    if (immediate) hover.amount = hover.tiltX = hover.tiltY = hover.lightX = hover.lightY = 0;
  }
  function draw() {
    if (reveal.render()) return;
    const radians = (yaw + hover.tiltY) * Math.PI / 180;
    object.style.transform = `translate(-50%, -50%) translateY(${-5 * hover.amount}px) rotateX(${pitch + hover.tiltX}deg) rotateY(${yaw + hover.tiltY}deg) rotateZ(-2deg) scale(${1 + .012 * hover.amount})`;
    for (const [key, value] of Object.entries({ lx: `${50 + Math.sin(radians) * 45}%`, ly: `${35 + Math.sin(pitch * Math.PI / 180) * 30}%`, hue: `${112 + Math.sin(radians) * 130}deg`, glint: .35 + Math.abs(Math.sin(radians)) * .5, hx: `${50 + hover.lightX * 42}%`, hy: `${50 + hover.lightY * 42}%`, hover: hover.amount })) object.style.setProperty(`--np-${key}`, value);
    atmosphere.style.transform = object.style.transform; atmosphere.style.setProperty('--np-hover', hover.amount);
    const frontVisible = Math.cos(radians) >= 0;
    if (frontVisible !== visibleFace) {
      visibleFace = frontVisible;
      front.setAttribute('aria-hidden', String(!frontVisible)); back.setAttribute('aria-hidden', String(frontVisible));
      flipButton.textContent = t(frontVisible ? 'nameplateBack' : 'nameplateFront');
    }
    shadow.style.opacity = (.38 + Math.abs(Math.cos(radians)) * .45) * (1 - hover.amount * .12);
    shadow.style.transform = `scaleX(${.45 + Math.abs(Math.cos(radians)) * .55 - hover.amount * .04})`;
  }
  function renderMotion() {
    motion.setAttribute('aria-pressed', String(rotating)); motion.textContent = t(rotating ? 'nameplatePause' : 'nameplateResume');
  }
  function flip() {
    if (reveal.active) return;
    clearHover();
    const frontVisible = Math.cos(yaw * Math.PI / 180) >= 0;
    turnTo = Math.round(yaw / 360) * 360 + (frontVisible ? 180 : 0);
    velocityX = velocityY = 0; idleUntil = performance.now() + 4500;
    live.textContent = t(frontVisible ? 'nameplateBack' : 'nameplateFront');
    if (reduced.matches) { yaw = turnTo; pitch = -9; turnTo = null; draw(); }
    wake();
  }
  listen(motion, 'click', () => { rotating = !rotating; velocityX = velocityY = 0; idleUntil = 0; renderMotion(); wake(); });
  listen(flipButton, 'click', flip);
  listen(stage, 'click', () => { if (suppressClick) { suppressClick = false; return; } flip(); });
  listen(stage, 'pointerdown', event => {
    if (reveal.active || !event.isPrimary || event.button !== 0) return;
    // Hand the displayed hover angle to the drag instead of snapping to its base angle.
    yaw += hover.tiltY; pitch = clamp(pitch + hover.tiltX, -65, 65);
    clearHover(); hover.tiltX = hover.tiltY = 0;
    pointer = event.pointerId; lastX = startX = event.clientX; lastY = startY = event.clientY;
    lastMove = performance.now(); moved = suppressClick = false; velocityX = velocityY = 0; turnTo = null;
    stage.setPointerCapture(pointer); stage.classList.add('is-dragging');
    wake();
  });
  listen(stage, 'pointermove', event => {
    if (pointer === null) {
      if (reveal.active) return;
      if (event.pointerType !== 'mouse' || event.buttons || reduced.matches || !object.contains(event.target)) { clearHover(); return; }
      const bounds = stage.getBoundingClientRect();
      hover.x = clamp((event.clientX - bounds.left - bounds.width * .5) / (object.offsetWidth * .5), -1, 1);
      hover.y = clamp((event.clientY - bounds.top - bounds.height * .48) / (object.offsetHeight * .5), -1, 1);
      hover.inside = true; wake(); return;
    }
    if (event.pointerId !== pointer) return;
    const now = performance.now(), dx = event.clientX - lastX, dy = event.clientY - lastY, dt = clamp(now - lastMove, 8, 80);
    if (Math.hypot(event.clientX - startX, event.clientY - startY) > 4) moved = true;
    yaw += dx * .48; pitch = clamp(pitch - dy * .38, -65, 65);
    velocityY = clamp(dx * .48 / dt * 1000, -170, 170); velocityX = clamp(-dy * .38 / dt * 1000, -85, 85);
    // Pointer events may arrive faster than the display; paint only in the frame loop.
    lastX = event.clientX; lastY = event.clientY; lastMove = now; wake();
  });
  function release(event) {
    if (event.pointerId !== pointer) return;
    pointer = null; stage.classList.remove('is-dragging'); idleUntil = performance.now() + 1600;
    if (performance.now() - lastMove > 100 || reduced.matches || event.type !== 'pointerup') velocityX = velocityY = 0;
    suppressClick = moved;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    wake();
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(stage, event, release);
  listen(stage, 'pointerleave', () => { clearHover(); wake(); });
  listen(stage, 'keydown', event => {
    const change = { ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, 8], ArrowDown: [0, -8] }[event.key];
    if (!change) return;
    event.preventDefault(); clearHover(true); turnTo = null; yaw += change[0]; pitch = clamp(pitch + change[1], -65, 65);
    velocityX = velocityY = 0; idleUntil = performance.now() + 4000; draw(); wake();
  });
  listen(reduced, 'change', () => { if (reduced.matches) { rotating = false; velocityX = velocityY = 0; if (turnTo !== null) yaw = turnTo; turnTo = null; clearHover(true); renderMotion(); draw(); } wake(); });
  listen(window, 'blur', () => { clearHover(); wake(); });
  // Stop the frame loop when closed, hidden, paused and settled, or restored from page cache.
  function wake() { if (!destroyed && !document.hidden && !frame) { previous = performance.now(); frame = requestAnimationFrame(animate); } }
  function animate(now) {
    frame = 0;
    if (destroyed || document.hidden) return;
    const dt = Math.min((now - previous) / 1000, .05); previous = now;
    const active = hover.inside && !reduced.matches && pointer === null && turnTo === null;
    const ease = 1 - Math.exp(-dt * 10);
    for (const [key, target] of Object.entries({ amount: active ? 1 : 0, tiltX: active ? -hover.y * 5 : 0, tiltY: active ? hover.x * 8 : 0, lightX: active ? hover.x : 0, lightY: active ? hover.y : 0 })) {
      hover[key] += (target - hover[key]) * ease;
      if (Math.abs(target - hover[key]) < .001) hover[key] = target;
    }
    if (!reveal.active && pointer === null) {
      if (turnTo !== null) {
        const delta = turnTo - yaw; yaw += delta * Math.min(1, dt * 7); pitch += (-9 - pitch) * Math.min(1, dt * 7);
        if (Math.abs(delta) < .08) { yaw = turnTo; turnTo = null; }
      } else {
        if (!reduced.matches) { yaw += velocityY * dt; pitch = clamp(pitch + velocityX * dt, -65, 65); velocityX *= Math.exp(-5 * dt); velocityY *= Math.exp(-5 * dt); }
        if (rotating && !active && now > idleUntil) { yaw += 4.8 * dt; pitch += (-9 - pitch) * Math.min(1, dt * .8); }
      }
    }
    draw();
    const hovering = Object.entries({ amount: active ? 1 : 0, tiltX: active ? -hover.y * 5 : 0, tiltY: active ? hover.x * 8 : 0, lightX: active ? hover.x : 0, lightY: active ? hover.y : 0 }).some(([key, target]) => hover[key] !== target);
    if (reveal.active || rotating || turnTo !== null || hovering || (!reduced.matches && (Math.abs(velocityX) > .01 || Math.abs(velocityY) > .01))) frame = requestAnimationFrame(animate);
  }
  listen(document, 'visibilitychange', () => { clearHover(true); if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else wake(); });
  listen(window, 'pagehide', () => { cancelAnimationFrame(frame); frame = 0; });
  listen(window, 'pageshow', wake);
  renderMotion(); draw(); wake();
  return {
    collect() { clearHover(true); const completion = reveal.collect(); wake(); return completion; },
    destroy() { reveal.destroy(); destroyed = true; cancelAnimationFrame(frame); events.abort(); section.getAnimations({ subtree: true }).forEach(animation => animation.cancel()); },
  };
}
