// executeScript serializes this function: all injected state must stay inside it.
export function injectModal(modalUrl) {
  const slot = '__historySweepModalHost';
  if (globalThis[slot]?.isConnected()) {
    globalThis[slot].close();
    return { opened: false };
  }
  const previousFocus = document.activeElement;
  const page = document.documentElement;
  const hadInlineStyle = page.hasAttribute('style');
  const scrollPosition = { left: window.scrollX, top: window.scrollY };
  const scrollProperties = ['overflow-x', 'overflow-y', 'overscroll-behavior-x', 'overscroll-behavior-y', 'scrollbar-gutter'];
  const previousStyles = scrollProperties.map(property => [property, page.style.getPropertyValue(property), page.style.getPropertyPriority(property)]);
  const scrollbarGutter = getComputedStyle(page).scrollbarGutter;
  const scrollEvents = new AbortController();
  const host = document.createElement('div');
  host.style.setProperty('all', 'initial', 'important');
  // The page cannot inspect the iframe launch token or alter the extension's inner UI.
  const root = host.attachShadow({ mode: 'closed' });
  const sheet = new CSSStyleSheet();
  const danceStageHeader = 64;
  sheet.replaceSync(`
    dialog { box-sizing: border-box; width: min(1080px, calc(100vw - 40px)); height: min(760px, calc(100vh - 40px)); max-width: none; max-height: none; padding: 0; border: 1px solid #ffffff90; border-radius: 24px; background: #f2f2f2; box-shadow: 0 24px 100px #00000040; overflow: hidden; }
    /* Dim the live page without sampling it through a viewport-sized blur while the modal animates. */
    dialog::backdrop { background: #18181870; transition: opacity 160ms ease; }
    /* Keep the iframe opaque on entry once its themed startup surface can paint. */
    dialog, dialog::backdrop { opacity: 0; }
    dialog[data-surface-ready], dialog[data-surface-ready]::backdrop { opacity: 1; }
    dialog[data-closing] { transition: opacity 160ms ease; }
    dialog[data-closing], dialog[data-closing]::backdrop { opacity: 0; }
    dialog[data-nameplate-phase=revealing] { animation: nameplate-arrive 2.25s ease-out both; }
    dialog[data-nameplate-phase=settled] { box-shadow: 0 24px 100px #00000040, 0 0 0 1px rgb(var(--np-energy) / .25), 0 0 32px rgb(var(--np-energy) / .2), 0 0 70px rgb(var(--np-energy) / .08); }
    dialog[data-nameplate-phase=collecting] { animation: nameplate-depart 1.05s ease-out both; }
    @keyframes nameplate-arrive {
      0% { box-shadow: 0 24px 100px #00000040; }
      100% { box-shadow: 0 24px 100px #00000040, 0 0 0 1px rgb(var(--np-energy) / .25), 0 0 32px rgb(var(--np-energy) / .2), 0 0 70px rgb(var(--np-energy) / .08); }
      32% { box-shadow: 0 24px 100px #00000040, 0 0 0 1px rgb(var(--np-energy) / .5), 0 0 28px rgb(var(--np-energy) / .2); }
      48% { box-shadow: 0 24px 100px #00000040, 0 0 0 1px rgb(var(--np-energy) / .7), 0 0 42px rgb(var(--np-energy) / .35), 0 0 100px rgb(var(--np-energy) / .16); }
    }
    @keyframes nameplate-depart {
      0% { box-shadow: 0 24px 100px #00000040, 0 0 0 1px rgb(var(--np-energy) / .25), 0 0 32px rgb(var(--np-energy) / .2), 0 0 70px rgb(var(--np-energy) / .08); }
      28% { box-shadow: 0 24px 100px #00000040, 0 0 50px rgb(var(--np-energy) / .28); }
      100% { box-shadow: 0 24px 100px #00000040; }
    }
    dialog[data-nameplate-reduced=true] { animation: none; }
    @media (prefers-reduced-motion: reduce) { dialog, dialog[data-closing], dialog::backdrop { transition: none; animation: none; } }
    iframe { display: block; width: 100%; height: 100%; border: 0; background: #f2f2f2; }
    .modal-close { position: absolute; top: 16px; right: 16px; width: 30px; height: 30px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 9px; background: transparent; color: #333; cursor: pointer; user-select: none; }
    .close-icon { display: block; width: 18px; height: 18px; fill: currentColor; }
    button[hidden] { display: none; }
    .modal-close:hover { background: #dadada; }
    dialog[data-theme=dark] { background: #161616; border-color: #424242; }
    dialog[data-theme=dark] iframe { background: #161616; }
    dialog[data-theme=dark] .modal-close { background: transparent; color: #ededed; }
    dialog[data-theme=dark] .modal-close:hover { background: #3a3a3a; }
    /* This shadow root cannot inherit the extension iframe's canvas and control colors. */
    dialog[data-theme-preset=warm-paper] { --host-canvas: #f1e9dc; --host-line: #ded0bd; --host-ink: #382b20; --host-hover: #e9dac8; --host-focus: #745037; }
    dialog[data-theme-preset=warm-paper][data-theme=dark] { --host-canvas: #211a16; --host-line: #544337; --host-ink: #f1e6d9; --host-hover: #49392e; --host-focus: #eac69f; }
    dialog[data-theme-preset=mist-blue] { --host-canvas: #e8eef6; --host-line: #cad8e9; --host-ink: #233246; --host-hover: #dce8f7; --host-focus: #2e5a86; }
    dialog[data-theme-preset=mist-blue][data-theme=dark] { --host-canvas: #141e2d; --host-line: #435870; --host-ink: #e7f0fc; --host-hover: #32465e; --host-focus: #a8c9f0; }
    dialog[data-theme-preset=moss-green] { --host-canvas: #e8ede2; --host-line: #cddbc5; --host-ink: #293624; --host-hover: #dfead6; --host-focus: #3f6337; }
    dialog[data-theme-preset=moss-green][data-theme=dark] { --host-canvas: #182117; --host-line: #455b41; --host-ink: #e6f1e1; --host-hover: #394d36; --host-focus: #b4d5a8; }
    dialog[data-theme-preset=dusk-plum] { --host-canvas: #efeaf5; --host-line: #decee8; --host-ink: #382a46; --host-hover: #eadff4; --host-focus: #6b4789; }
    dialog[data-theme-preset=dusk-plum][data-theme=dark] { --host-canvas: #211a2c; --host-line: #59476b; --host-ink: #f3eafa; --host-hover: #49375c; --host-focus: #d8b8f0; }
    dialog[data-theme-preset]:not([data-theme-preset=classic]) { background: var(--host-canvas); border-color: var(--host-line); }
    dialog[data-theme-preset]:not([data-theme-preset=classic]) iframe { background: var(--host-canvas); }
    dialog[data-theme-preset]:not([data-theme-preset=classic]) .modal-close { color: var(--host-ink); }
    dialog[data-theme-preset]:not([data-theme-preset=classic]) .modal-close:hover { background: var(--host-hover); }
    dialog[data-theme-preset]:not([data-theme-preset=classic]) .modal-close:focus-visible { outline-color: var(--host-focus); }
    button:focus-visible { outline: 2px solid #555; outline-offset: 2px; }
    @media (max-width: 520px) { dialog { width: calc(100vw - 16px); height: calc(100vh - 16px); border-radius: 18px; } .modal-close { right: 12px; } }
    dialog[data-agent-peek] { overflow: visible; }
    dialog[data-agent-peek] iframe { border-radius: inherit; }
    .agent-peek { position: absolute; top: clamp(100px, 23%, 176px); right: -43px; width: 52px; height: 64px; padding: 0; border: 0; border-radius: 12px; background: transparent; cursor: grab; touch-action: none; user-select: none; }
    .agent-peek:active { cursor: grabbing; }
    .agent-peek:focus-visible { outline-color: #c4abf3; }
    .peek-art { position: absolute; inset: 0 auto auto 5px; width: 48px; height: 64px; overflow: hidden; filter: drop-shadow(1px 2px 3px #27173a40); pointer-events: none; }
    .peek-frames { display: block; width: 200%; height: 100%; }
    .agent-peek:is(:hover, :focus-visible) .peek-frames { transform: translateX(-50%); }
    .agent-peek[data-performing] .peek-art { visibility: hidden; }
    .peek-signal { display: none; position: absolute; top: 6.3%; left: 89.6%; width: 6px; height: 6px; transform: translate(-50%, -50%); border: 1px solid #3e6945; border-radius: 50%; background: #a9d79c; }
    .agent-peek[data-busy] .peek-signal { display: block; }
    .agent-dance-lighting {
      --beam-top: 100px;
      --beam-width: 17%;
      --beam-left-source: 20%;
      --beam-bottom: clamp(calc(var(--beam-top) + 52px), var(--dance-aim-y), 96%);
      --beam-left: calc(var(--dance-aim-x) - var(--beam-width));
      --beam-right: calc(var(--dance-aim-x) + var(--beam-width));
      position: absolute; inset: 0; z-index: 1; border-radius: inherit;
      clip-path: inset(${danceStageHeader}px 0 0); opacity: 0; visibility: hidden; pointer-events: none;
      transition: opacity 180ms ease-out, visibility 180ms;
      background:
        radial-gradient(ellipse 8px 3px at var(--beam-left-source) var(--beam-top), #e2baff 70%, transparent),
        radial-gradient(ellipse 8px 3px at 80% var(--beam-top), #b2f0ff 70%, transparent),
        radial-gradient(ellipse at var(--dance-aim-x) var(--beam-bottom), #30214522, transparent 62%),
        radial-gradient(ellipse at 16% 0%, #2519371a, transparent 52%),
        radial-gradient(ellipse at 81% 6%, #1d243d1a, transparent 55%), #110f1d1a;
    }
    @media (max-width: 520px) {
      .agent-dance-lighting { --beam-top: 116px; --beam-left-source: 10%; }
    }
    /* Keep the stage decorative so focus can move to visible controls without changing its lighting. */
    dialog:has(.agent-dance-stage[data-dancing]) .agent-dance-lighting { opacity: 1; visibility: visible; }
    .agent-dance-beams { position: absolute; inset: 0; filter: blur(5px); pointer-events: none; }
    .agent-dance-beams::before, .agent-dance-beams::after { content: ''; position: absolute; inset: 0; }
    .agent-dance-beams::before {
      clip-path: polygon(calc(var(--beam-left-source) - .3%) var(--beam-top), calc(var(--beam-left-source) + .3%) var(--beam-top), var(--beam-right) var(--beam-bottom), var(--beam-left) var(--beam-bottom));
      background: linear-gradient(#bf8cff80 var(--beam-top), #a276fa06 var(--beam-bottom));
    }
    .agent-dance-beams::after {
      clip-path: polygon(79.7% var(--beam-top), 80.3% var(--beam-top), var(--beam-right) var(--beam-bottom), var(--beam-left) var(--beam-bottom));
      background: linear-gradient(#8ce9fc78 var(--beam-top), #76b6ff06 var(--beam-bottom));
    }
    .agent-dance-stage { position: absolute; inset: 0; z-index: 2; border-radius: inherit; overflow: hidden; pointer-events: none; }
    .agent-dance-stage[data-capture] { pointer-events: auto; }
    .agent-dancer { position: absolute; top: 0; left: 0; width: 116px; height: 127.6px; transform-origin: 50% 89.77%; }
    .agent-dancer::after { content: ''; position: absolute; top: 88%; left: 26%; width: 48%; height: 8px; border-radius: 50%; background: #4d32634a; filter: blur(4px); }
    .agent-dance-stage[data-dancing] .agent-dancer::after {
      top: calc(89.77% - 16px); left: -38%; width: 176%; height: 32px; filter: none;
      background:
        radial-gradient(ellipse 25% 28% at center, #10091b9c, transparent),
        radial-gradient(ellipse at center, #bf98ff72, #a87bf62b 52%, transparent 75%),
        radial-gradient(ellipse 46% 45% at center, transparent 94%, #bda2ff60 98%, transparent 100%),
        radial-gradient(ellipse 35% 32% at center, transparent 92%, #9fbcf54d 97%, transparent 100%);
    }
    .agent-dance-clip { position: absolute; inset: 0; z-index: 1; overflow: hidden; }
    .agent-dance-frames { display: block; width: 100%; height: 100%; object-fit: contain; }
    .agent-dance-grip { position: absolute; inset: 14% 16% 9%; z-index: 2; touch-action: none; user-select: none; }
    .agent-dance-stage[data-repositionable] .agent-dance-grip { pointer-events: auto; cursor: grab; }
    .agent-dance-stage[data-capture] .agent-dance-grip { cursor: grabbing; }
    /* Give the stop control its own space so it never covers the workspace footer. */
    dialog:has(.agent-dance-stage[data-dancing]) iframe {
      height: calc(100% - 56px);
      border-bottom-left-radius: 0; border-bottom-right-radius: 0;
    }
    .agent-dance-stop {
      --stop-hover: #77519518;
      --stop-pressed: #77519526;
      position: absolute; z-index: 3; inset: auto 12px 6px; margin-inline: auto;
      width: fit-content; min-width: 96px; min-height: 44px; padding: 0 16px;
      border: 0; border-radius: 999px; background: transparent; color: #513964;
      font: 500 13px/1.4 system-ui, sans-serif; cursor: pointer;
    }
    dialog[data-theme=dark] .agent-dance-stop {
      --stop-hover: #eee0ff12;
      --stop-pressed: #eee0ff1e;
      color: #d8cce3;
    }
    .agent-dance-stop:hover { background: var(--stop-hover); }
    .agent-dance-stop:active { background: var(--stop-pressed); }
    .agent-dance-stop:focus-visible { outline-color: #9773b4; }
    .agent-dance-load-status {
      position: absolute; z-index: 3; inset: auto 12px 16px; margin-inline: auto;
      width: fit-content; max-width: calc(100% - 24px); box-sizing: border-box;
      padding: 8px 12px; border-radius: 10px; background: #21192e; color: #f5eafa;
      font: 500 13px/1.4 system-ui, sans-serif; pointer-events: none;
    }
    .agent-dance-load-status:empty { opacity: 0; }
    @media (prefers-reduced-motion: no-preference) {
      .agent-peek[data-arriving] .peek-art { animation: peek-arrive 480ms cubic-bezier(.2,.75,.24,1) both; }
      .agent-peek:not([data-busy]):not(:hover, :focus-visible) .peek-frames { animation: peek-blink 9s steps(1, end) infinite; }
      .agent-peek[data-busy] .peek-signal { animation: peek-signal 1.6s ease-in-out infinite; }
    }
    @media (prefers-reduced-motion: reduce) { .agent-dance-lighting { transition: none; } }
    @keyframes peek-arrive { from { opacity: 0; transform: translateX(-10px); } 65% { transform: translateX(2px); } to { opacity: 1; transform: none; } }
    @keyframes peek-blink { 0%, 39%, 100% { transform: none; } 36% { transform: translateX(-50%); } }
    @keyframes peek-signal { 50% { opacity: .5; } }
  `);
  root.adoptedStyleSheets = [sheet];
  const dialog = document.createElement('dialog');
  dialog.setAttribute('aria-label', 'History Sweep');
  const frame = document.createElement('iframe');
  frame.title = 'History Sweep';
  // Cross-origin frames need clipboard delegation even for a direct copy-button click.
  frame.allow = 'clipboard-write';
  frame.src = modalUrl;
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'modal-close';
  closeButton.setAttribute('aria-label', '关闭 History Sweep / Close History Sweep');
  // Inline icons/ui/x.svg because executeScript serializes this function in isolation.
  const closeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  closeIcon.setAttribute('class', 'close-icon');
  closeIcon.setAttribute('viewBox', '0 0 256 256');
  closeIcon.setAttribute('aria-hidden', 'true');
  const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  closePath.setAttribute('d', 'M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z');
  closeIcon.append(closePath);
  closeButton.append(closeIcon);
  const agentPeek = document.createElement('button');
  agentPeek.type = 'button';
  agentPeek.className = 'agent-peek';
  agentPeek.hidden = true;
  agentPeek.setAttribute('aria-haspopup', 'dialog');
  const peekArt = document.createElement('span');
  peekArt.className = 'peek-art';
  peekArt.setAttribute('aria-hidden', 'true');
  const peekFrames = document.createElement('canvas');
  peekFrames.className = 'peek-frames';
  const peekSignal = document.createElement('span');
  peekSignal.className = 'peek-signal';
  peekArt.append(peekFrames, peekSignal);
  agentPeek.append(peekArt);
  const danceLighting = document.createElement('div');
  danceLighting.className = 'agent-dance-lighting';
  danceLighting.setAttribute('aria-hidden', 'true');
  const danceBeams = document.createElement('div');
  danceBeams.className = 'agent-dance-beams';
  danceLighting.append(danceBeams);
  const stage = document.createElement('div');
  stage.className = 'agent-dance-stage';
  stage.hidden = true;
  stage.setAttribute('aria-hidden', 'true');
  const dancer = document.createElement('div');
  dancer.className = 'agent-dancer';
  const danceClip = document.createElement('div');
  danceClip.className = 'agent-dance-clip';
  const danceFrames = document.createElement('canvas');
  danceFrames.className = 'agent-dance-frames';
  const danceContext = danceFrames.getContext('2d');
  const danceGrip = document.createElement('span');
  danceGrip.className = 'agent-dance-grip';
  danceClip.append(danceFrames);
  dancer.append(danceClip, danceGrip);
  stage.append(dancer);
  const stopDance = document.createElement('button');
  stopDance.type = 'button';
  stopDance.className = 'agent-dance-stop';
  stopDance.hidden = true;
  const danceLoadStatus = document.createElement('div');
  danceLoadStatus.className = 'agent-dance-load-status';
  danceLoadStatus.setAttribute('role', 'status');
  for (const eventName of ['animationend', 'animationcancel']) {
    agentPeek.addEventListener(eventName, event => { if (event.animationName === 'peek-arrive') delete agentPeek.dataset.arriving; });
  }
  const parsedUrl = new URL(modalUrl);
  const frameOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
  // Leave room for the exposed head and its focus ring outside the centered 1080px dialog.
  const agentRoom = matchMedia('(min-width: 1200px) and (min-height: 320px)');
  const reduceDanceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let agentPort;
  let peekReady = false;
  let peekTitle;
  let danceDownloading;
  let danceUnavailable;
  let dancePreviewReady = false;
  let danceAtlas;
  let danceTrack;
  let danceLoading = false;
  let danceLoadNoticeTimer;
  let pendingDance;
  let agentBlocked = false;
  let agentShown = false;
  let restoreAgentFocus = false;
  let settingsDock = false;
  let gesture;
  let dance;
  let swallowClick;
  let dismissRequest = 0;
  let pendingDismiss = null;
  let preferencesOpen = false, nameplateOpen = false, updateOpen = false;
  let workspaceCloseReady = false;
  const childLayerOpen = () => preferencesOpen || nameplateOpen || updateOpen;
  const canDance = source => dialog.open && !dialog.inert && (source === 'settings' ? settingsDock : !agentPeek.hidden);
  function setDanceLoadState(source, state) {
    clearTimeout(danceLoadNoticeTimer);
    danceLoadStatus.textContent = state === 'loading' ? danceDownloading : state === 'failed' ? danceUnavailable : '';
    if (state === 'failed') danceLoadNoticeTimer = setTimeout(() => { danceLoadStatus.textContent = ''; }, 5000);
    if (source === 'workspace') {
      agentPeek.setAttribute('aria-busy', String(state === 'loading'));
      agentPeek.title = state === 'failed' ? danceUnavailable : peekTitle;
    }
    agentPort.postMessage({ type: 'dance-load-state', source, state });
  }
  function clearPendingDance(state = 'idle') {
    const pending = pendingDance;
    if (pending) {
      pendingDance = undefined;
      setDanceLoadState(pending.source, state);
    }
    return pending;
  }
  function setDanceActive(active, source) {
    stage.hidden = !active;
    dancer.hidden = !active;
    agentPeek.toggleAttribute('data-performing', active && source === 'workspace');
    agentPort.postMessage({ type: 'dance-state', active, source });
  }
  function finishDance(restoreFocus = true) {
    const source = dance?.source ?? gesture?.source ?? pendingDance?.source;
    if (!source) return;
    const returnFocus = restoreFocus && root.activeElement === stopDance;
    if (gesture?.dragged) swallowClick = source;
    if (dance) releaseDancer(dance);
    dance?.motion?.cancel();
    cancelAnimationFrame(dance?.frameRequest);
    clearTimeout(dance?.timer);
    dance = undefined;
    gesture = undefined;
    clearPendingDance();
    stopDance.hidden = true;
    dancer.style.width = '';
    dancer.style.height = '';
    dancer.style.translate = '';
    dancer.style.clipPath = '';
    danceFrames.style.transform = '';
    stage.removeAttribute('data-capture');
    stage.removeAttribute('data-dancing');
    stage.removeAttribute('data-repositionable');
    setDanceActive(false, source);
    if (danceAtlas) drawDanceFrame(0);
    if (returnFocus && canDance(source)) {
      if (source === 'settings') agentPort.postMessage({ type: 'focus-dance-dock' });
      else agentPeek.focus({ preventScroll: true });
    }
  }
  function dancerTransform(point) {
    const panel = dialog.getBoundingClientRect();
    const width = dancer.offsetWidth;
    const height = dancer.offsetHeight;
    const left = point.x - panel.left - width / 2;
    const top = point.y - panel.top - height / 2;
    const x = Math.max(0, Math.min(panel.width - width, left));
    const y = Math.max(0, Math.min(panel.height - height, top));
    return `translate(${x}px, ${y}px)`;
  }
  function moveDragPreview() {
    if (!gesture?.dragged || (!danceAtlas && !dancePreviewReady)) return;
    if (stage.hidden || dancer.hidden) setDanceActive(true, gesture.source);
    dancer.style.transform = dancerTransform(gesture.point);
  }
  function aimDanceLights(x, y) {
    danceLighting.style.setProperty('--dance-aim-x', `${x}px`);
    danceLighting.style.setProperty('--dance-aim-y', `${y}px`);
  }
  function drawDanceFrame(index) {
    const { width, height, columns, left, top } = danceTrack.tile;
    danceContext.drawImage(danceAtlas, index % columns * width, Math.floor(index / columns) * height, width, height, left, top, width, height);
  }
  function releaseDancer(active) {
    if (!active.grab) return;
    const id = active.grab.id;
    active.grab = undefined;
    stage.removeAttribute('data-capture');
    if (danceGrip.hasPointerCapture(id)) danceGrip.releasePointerCapture(id);
  }
  function translateDancer(active, x, y) {
    if (active.offset.x === x && active.offset.y === y) return;
    active.offset = { x, y };
    dancer.style.translate = x || y ? `${x}px ${y}px` : '';
  }
  function positionDancer(active) {
    if (!active.grab && !active.shift.x && !active.shift.y) return;
    const bounds = dancer.getBoundingClientRect();
    const limits = stage.getBoundingClientRect();
    const left = bounds.left - active.offset.x;
    const top = bounds.top - active.offset.y;
    const x = active.grab ? active.grab.x - active.grab.left * bounds.width - left : active.shift.x;
    const y = active.grab ? active.grab.y - active.grab.top * bounds.height - top : active.shift.y;
    const within = (value, min, max) => Math.max(min, Math.min(max, value));
    translateDancer(active, within(x, limits.left - left, limits.right - left - bounds.width), within(y, limits.top - top, limits.bottom - top - bounds.height));
    if (active.grab) active.shift = active.offset;
  }
  danceGrip.addEventListener('pointerdown', event => {
    if (!dance || !stage.hasAttribute('data-repositionable') || dance.grab || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const bounds = dancer.getBoundingClientRect();
    dance.grab = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      left: (event.clientX - bounds.left) / bounds.width, top: (event.clientY - bounds.top) / bounds.height,
    };
    stage.dataset.capture = '';
    danceGrip.setPointerCapture(event.pointerId);
  });
  for (const phase of ['pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    danceGrip.addEventListener(phase, event => {
      if (dance?.grab?.id !== event.pointerId) return;
      if (phase === 'pointermove' || phase === 'pointerup') {
        dance.grab.x = event.clientX;
        dance.grab.y = event.clientY;
        positionDancer(dance);
      }
      if (phase !== 'pointermove') releaseDancer(dance);
    });
  }
  function beginDance(source, point, home) {
    if (!canDance(source) || dance || pendingDance) return;
    if (!danceAtlas) {
      pendingDance = { source, point, home };
      setDanceLoadState(source, 'loading');
      if (!danceLoading) {
        danceLoading = true;
        agentPort.postMessage({ type: 'load-dance-artwork' });
      }
      return;
    }
    setDanceActive(true, source);
    stage.toggleAttribute('data-dancing', true);
    stage.dataset.repositionable = '';
    stopDance.hidden = false;
    stopDance.focus({ preventScroll: true });
    const danceDuration = danceTrack.duration * 1000;
    dance = { source, shift: { x: 0, y: 0 }, offset: { x: 0, y: 0 } };
    const panel = dialog.getBoundingClientRect();
    const { floor, fps, positions, hopFrames, stage: area, canvas } = danceTrack;
    if (reduceDanceMotion.matches) {
      // The stationary pose cannot travel down from a dock in the title bar.
      const y = Math.max(point.y, panel.top + danceStageHeader + dancer.offsetHeight / 2);
      dancer.style.transform = dancerTransform({ x: point.x, y });
      const pose = dancer.getBoundingClientRect();
      aimDanceLights(pose.left - panel.left + pose.width / 2, pose.top - panel.top + pose.height * floor);
      dance.timer = setTimeout(finishDance, danceDuration);
      return;
    }
    dancer.style.transform = dancerTransform(point);
    const camera = Math.min(panel.width / area.width, panel.height / area.height, 1.55);
    const width = area.actor * camera;
    const height = width * canvas.height / canvas.width;
    const dragWidth = dancer.offsetWidth;
    const dragHeight = dragWidth * canvas.height / canvas.width;
    dancer.style.width = `${width}px`;
    dancer.style.height = `${height}px`;
    const clampedCenter = (value, extent, size) => Math.max(size / 2, Math.min(extent - size / 2, value));
    const drop = [
      clampedCenter(point.x - panel.left, panel.width, dragWidth),
      clampedCenter(point.y - panel.top, panel.height, dragHeight) + dragHeight * (floor - .5),
    ];
    const dockScale = .32;
    const dock = [home.x - panel.left, home.y - panel.top + height * (floor - .5) * dockScale];
    const mirrored = drop[0] > panel.width / 2;
    const stageX = x => mirrored ? area.width - x : x;
    const origin = [
      Math.max(0, Math.min(panel.width - area.width * camera, drop[0] - stageX(positions[0][0]) * camera)),
      Math.max(0, Math.min(panel.height - area.height * camera, drop[1] - positions[0][1] * camera)),
    ];
    if (mirrored) danceFrames.style.transform = 'scaleX(-1)';
    const blend = (a, b, t) => a + (b - a) * t;
    const clamp = t => Math.max(0, Math.min(1, t));
    const smooth = value => {
      const t = clamp(value);
      return t * t * (3 - 2 * t);
    };
    const onStage = ([x, y]) => [origin[0] + stageX(x) * camera, origin[1] + y * camera];
    aimDanceLights(...onStage(positions[0]));
    const takeoff = onStage(positions.at(-1));
    const distance = Math.hypot(dock[0] - takeoff[0], dock[1] - takeoff[1]);
    const hopDuration = 620 + Math.min(180, distance * .18);
    const duration = danceDuration + hopDuration;
    const transform = ([x, y], size) => `translate(${x - width / 2}px, ${y - height * floor}px) scale(${size})`;
    const concealment = progress => smooth((progress - .81) / .12);
    // The atlas and the stage path share the same clock and spatial scale, so a planted foot holds its ground.
    const path = positions.map((position, index) => {
      const time = index * 1000 / fps;
      const enter = smooth(time / 650);
      const point = onStage(position).map((value, axis) => blend(drop[axis], value, enter));
      return { transform: transform(point, blend(dragWidth / width, 1, enter)), offset: time / duration };
    });
    const arcHeight = Math.min(110, 36 + distance * .14);
    for (let index = 0; index < hopFrames; index++) {
      const progress = index / (hopFrames - 1);
      const flight = clamp((progress - .16) / .70);
      const cover = concealment(progress);
      const [x, y] = takeoff.map((value, axis) => blend(value, dock[axis], flight));
      const lift = 4 * arcHeight * flight * (1 - flight);
      path.push({
        transform: transform([x, y - lift + cover * 8], blend(1, dockScale, smooth((progress - .32) / .54))),
        offset: (danceDuration + progress * hopDuration) / duration,
      });
    }
    dance.motion = dancer.animate(path, { duration, fill: 'forwards' });
    dance.motion.onfinish = () => finishDance();
    const active = dance;
    let lastFrame = -1;
    let lastCover = 0;
    const paint = () => {
      if (dance !== active) return;
      const time = active.motion.currentTime;
      let index;
      if (time < danceDuration) {
        positionDancer(active);
        index = Math.min(positions.length - 1, Math.round(time * fps / 1000));
      } else {
        if (stage.hasAttribute('data-repositionable')) {
          stage.removeAttribute('data-repositionable');
          releaseDancer(active);
          active.shift = active.offset;
        }
        // A drag offsets the choreography without rewinding it; the hop carries that offset back to the dock.
        const remaining = 1 - clamp((time - danceDuration - hopDuration * .16) / (hopDuration * .70));
        translateDancer(active, active.shift.x * remaining, active.shift.y * remaining);
        const progress = clamp((time - danceDuration) / hopDuration);
        const cover = concealment(progress) * 100;
        // Only clip as the robot disappears behind the rim or into the settings dock.
        if (cover !== lastCover) {
          dancer.style.clipPath = source === 'workspace' ? `inset(0 ${cover}% 0 0)` : `inset(0 0 ${cover}% 0)`;
          lastCover = cover;
        }
        index = positions.length + Math.round(progress * (hopFrames - 1));
      }
      if (index !== lastFrame) { drawDanceFrame(index); lastFrame = index; }
      active.frameRequest = requestAnimationFrame(paint);
    };
    active.frameRequest = requestAnimationFrame(paint);
  }
  function trackDancePointer(source, phase, id, point, home = point) {
    if (phase === 'pointerdown') {
      if (!canDance(source) || dance || gesture || pendingDance) return;
      swallowClick = undefined;
      gesture = { source, id, start: point, home, dragged: false };
      if (source === 'workspace') {
        // Keep the host pointer capture when the dragged mascot crosses the cross-origin iframe.
        stage.hidden = false;
        dancer.hidden = true;
        stage.dataset.capture = '';
      }
      return;
    }
    if (gesture?.source !== source || gesture.id !== id) return;
    if (phase !== 'pointermove' && phase !== 'pointerup') { finishDance(false); return; }
    if (!gesture.dragged && Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > 8) gesture.dragged = true;
    if (gesture.dragged) {
      gesture.point = point;
      moveDragPreview();
    }
    if (phase !== 'pointerup') return;
    if (!gesture.dragged) { finishDance(false); return; }
    swallowClick = source;
    const panel = dialog.getBoundingClientRect();
    if (canDance(source) && point.x >= panel.left && point.x <= panel.right && point.y >= panel.top && point.y <= panel.bottom) {
      const dock = gesture.home;
      gesture = undefined;
      stage.removeAttribute('data-capture');
      beginDance(source, point, dock);
    } else finishDance(false);
  }
  function consumeDragClick(source, keyboard) {
    if (keyboard || swallowClick !== source) return false;
    swallowClick = undefined;
    return true;
  }
  function syncAgentPeek() {
    const placed = agentRoom.matches && peekReady && agentPeek.hasAttribute('aria-label');
    if (dialog.hasAttribute('data-agent-peek') !== placed) {
      const wasFocused = root.activeElement === agentPeek;
      dialog.toggleAttribute('data-agent-peek', placed);
      agentPort.postMessage({ type: 'placement', peek: placed, focus: wasFocused });
    }
    agentPeek.hidden = !placed || agentBlocked || childLayerOpen();
    if (agentPeek.hidden && (dance?.source === 'workspace' || gesture?.source === 'workspace' || pendingDance?.source === 'workspace')) finishDance(false);
    if (agentPeek.hidden) delete agentPeek.dataset.arriving;
    else if (!agentShown) {
      agentShown = true;
      if (matchMedia('(prefers-reduced-motion: no-preference)').matches) agentPeek.dataset.arriving = '';
    }
    if (restoreAgentFocus && !agentBlocked && !childLayerOpen()) {
      restoreAgentFocus = false;
      if (agentPeek.hidden) agentPort.postMessage({ type: 'focus-toolbar' });
      else agentPeek.focus({ preventScroll: true });
    }
  }
  const syncCloseButton = () => {
    const hidden = workspaceCloseReady || childLayerOpen();
    if (closeButton.hidden !== hidden) closeButton.hidden = hidden;
    syncAgentPeek();
  };
  function connectAgentPeek() {
    const channel = new MessageChannel();
    agentPort = channel.port1;
    agentPort.onmessage = ({ data }) => {
      if (data?.type === 'status') {
        agentPeek.setAttribute('aria-label', data.label);
        peekTitle = data.title;
        agentPeek.title = peekTitle;
        danceDownloading = data.danceDownloading;
        danceUnavailable = data.danceUnavailable;
        stopDance.textContent = data.stopLabel;
        agentPeek.toggleAttribute('data-busy', data.busy);
        agentBlocked = data.blocked;
        syncAgentPeek();
      } else if (data?.type === 'peek-artwork') {
        const peekContext = peekFrames.getContext('2d');
        if (peekContext) {
          peekFrames.width = data.bitmap.width;
          peekFrames.height = data.bitmap.height;
          peekContext.drawImage(data.bitmap, 0, 0);
          peekReady = true;
        }
        data.bitmap.close();
        syncAgentPeek();
      } else if (data?.type === 'dance-preview') {
        if (!danceAtlas && danceContext) {
          // The bundled preview is a horizontal strip of square poses.
          const size = data.bitmap.height;
          danceFrames.width = size;
          danceFrames.height = size;
          danceContext.drawImage(data.bitmap, 0, 0, size, size, 0, 0, size, size);
          dancePreviewReady = true;
          moveDragPreview();
        }
        data.bitmap.close();
      } else if (data?.type === 'dance-artwork' || data?.type === 'dance-unavailable') {
        danceLoading = false;
        if (data.type === 'dance-unavailable' || !danceContext) {
          data.dancer?.close();
          const pending = clearPendingDance('failed');
          if (pending) setDanceActive(false, pending.source);
          return;
        }
        danceAtlas = data.dancer;
        danceTrack = data.track;
        danceFrames.width = danceTrack.canvas.width;
        danceFrames.height = danceTrack.canvas.height;
        // Replace the whole pose, including transparent pixels, in one canvas operation.
        danceContext.globalCompositeOperation = 'copy';
        drawDanceFrame(0);
        const pending = clearPendingDance();
        if (pending) beginDance(pending.source, pending.point, pending.home);
      } else if (data?.type === 'dance-dock') {
        settingsDock = data.shown;
        if (!settingsDock && (dance?.source === 'settings' || gesture?.source === 'settings' || pendingDance?.source === 'settings')) finishDance(false);
      } else if (data?.type === 'dance-pointer' || data?.type === 'dance-click') {
        const bounds = frame.getBoundingClientRect();
        const point = { x: bounds.left + data.x, y: bounds.top + data.y };
        const home = data.home && { x: bounds.left + data.home.x, y: bounds.top + data.home.y };
        if (data.type === 'dance-pointer') trackDancePointer('settings', data.phase, data.id, point, home);
        else if (!consumeDragClick('settings', data.keyboard)) beginDance('settings', point, point);
      } else if (data?.type === 'stop-dance') {
        finishDance();
      } else if (data?.type === 'restore-focus') {
        restoreAgentFocus = true;
        syncAgentPeek();
      }
    };
    // The launch token binds this private port to the claimed extension frame, without exposing Agent state to the page.
    const token = new URLSearchParams(parsedUrl.hash.slice(1)).get('launch');
    frame.contentWindow.postMessage({ type: 'history-sweep:connect-agent-peek', token }, frameOrigin, [channel.port2]);
  }
  agentRoom.addEventListener('change', syncAgentPeek, { signal: scrollEvents.signal });
  reduceDanceMotion.addEventListener('change', event => {
    if (event.matches && dance?.motion) finishDance();
  }, { signal: scrollEvents.signal });
  window.addEventListener('resize', () => finishDance(false), { signal: scrollEvents.signal });
  for (const phase of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
    agentPeek.addEventListener(phase, event => {
      if (phase === 'pointerdown') {
        if (!event.isPrimary || event.button !== 0 || dance) return;
        agentPeek.setPointerCapture(event.pointerId);
      }
      const box = agentPeek.getBoundingClientRect();
      trackDancePointer('workspace', phase, event.pointerId, { x: event.clientX, y: event.clientY }, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
    });
  }
  agentPeek.addEventListener('click', event => {
    if (!consumeDragClick('workspace', event.detail === 0) && !dance) agentPort?.postMessage({ type: 'open-agent' });
  });
  stopDance.addEventListener('click', () => finishDance());
  async function close() {
    if (dialog.hasAttribute('data-closing')) return;
    dialog.dataset.closing = '';
    dialog.inert = true;
    // Keep the backdrop in the top layer until the fade has finished.
    const fades = dialog.getAnimations().filter(animation => animation.transitionProperty === 'opacity');
    if (fades.length) await Promise.allSettled(fades.map(animation => animation.finished));
    dialog.close();
  }
  function dismissLayer() {
    if (dialog.hasAttribute('data-closing')) return;
    if (dance || pendingDance || gesture?.dragged) { finishDance(); return; }
    // Ask the extension frame first: a calendar/filter must absorb the first backdrop click.
    pendingDismiss = ++dismissRequest;
    frame.contentWindow.postMessage({ type: 'history-sweep:dismiss-layer', requestId: pendingDismiss }, frameOrigin);
  }
  function requestClose() {
    // Toggling the toolbar icon must respect unsaved preferences in the child frame.
    if (childLayerOpen()) dismissLayer();
    else close();
  }
  function onMessage(event) {
    if (event.source !== frame.contentWindow || event.origin !== frameOrigin) return;
    if (event.data?.type === 'history-sweep:theme' && ['light', 'dark'].includes(event.data.theme)) {
      dialog.dataset.theme = event.data.theme;
      const preset = event.data.preset;
      dialog.dataset.themePreset = ['warm-paper', 'mist-blue', 'moss-green', 'dusk-plum'].includes(preset) ? preset : 'classic';
    }
    if (event.data?.type === 'history-sweep:startup-surface-ready' && dialog.dataset.theme) dialog.dataset.surfaceReady = '';
    if (event.data?.type === 'history-sweep:close-modal') close();
    if (event.data?.type === 'history-sweep:workspace-close-ready') {
      workspaceCloseReady = true;
      syncCloseButton();
      if (!agentPort) connectAgentPeek();
    }
    if (event.data?.type === 'history-sweep:preferences' && event.data.owner !== 'nameplate' && typeof event.data.open === 'boolean') {
      preferencesOpen = event.data.open;
      syncCloseButton();
    }
    if (event.data?.type === 'history-sweep:update-details' && typeof event.data.open === 'boolean') {
      updateOpen = event.data.open;
      syncCloseButton();
    }
    if (event.data?.type === 'history-sweep:nameplate' && typeof event.data.open === 'boolean') {
      nameplateOpen = event.data.open;
      syncCloseButton();
      const colors = { obsidian: '111 222 255', ivory: '218 190 143', aurora: '172 153 239', gold: '235 193 112' };
      if (nameplateOpen && Object.hasOwn(colors, event.data.material) && ['revealing', 'settled', 'collecting'].includes(event.data.phase)) {
        dialog.style.setProperty('--np-energy', colors[event.data.material]);
        dialog.dataset.nameplateReduced = String(event.data.reduced === true);
        dialog.dataset.nameplatePhase = event.data.phase;
      } else if (!nameplateOpen) {
        delete dialog.dataset.nameplatePhase; delete dialog.dataset.nameplateReduced;
        dialog.style.removeProperty('--np-energy');
      }
    }
    if (event.data?.type === 'history-sweep:layer-dismissed' && event.data.requestId === pendingDismiss && typeof event.data.handled === 'boolean') {
      pendingDismiss = null;
      if (!event.data.handled) close();
    }
  }
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dismissLayer();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismissLayer(); });
  dialog.addEventListener('close', () => {
    window.removeEventListener('message', onMessage);
    finishDance(false);
    clearTimeout(danceLoadNoticeTimer);
    danceAtlas?.close();
    agentPort?.close();
    scrollEvents.abort();
    for (const [property, value, priority] of previousStyles) {
      if (value) page.style.setProperty(property, value, priority);
      else page.style.removeProperty(property);
    }
    host.remove(); delete globalThis[slot];
    window.scrollTo({ ...scrollPosition, behavior: 'instant' });
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    if (!hadInlineStyle && page.getAttribute('style') === '') page.removeAttribute('style');
  }, { once: true });
  window.addEventListener('message', onMessage);
  const syncVisibility = () => { dialog.style.animationPlayState = document.hidden ? 'paused' : 'running'; };
  document.addEventListener('visibilitychange', syncVisibility, { signal: scrollEvents.signal });
  syncVisibility();
  dialog.append(agentPeek, frame, closeButton, danceLighting, stage, stopDance, danceLoadStatus); root.append(dialog); document.documentElement.append(host);
  globalThis[slot] = { close: requestClose, isConnected: () => host.isConnected };
  dialog.showModal();
  // A modal dialog makes the page inert, but does not lock its viewport scrolling.
  page.style.setProperty('overflow-x', 'hidden', 'important');
  page.style.setProperty('overflow-y', 'hidden', 'important');
  page.style.setProperty('overscroll-behavior-x', 'none', 'important');
  page.style.setProperty('overscroll-behavior-y', 'none', 'important');
  page.style.setProperty('scrollbar-gutter', scrollbarGutter === 'auto' ? 'stable' : scrollbarGutter, 'important');
  const blockBackgroundScroll = event => {
    if (!event.ctrlKey && !(event.touches?.length > 1)) event.preventDefault();
  };
  // Events inside the iframe stay there; only host/backdrop gestures reach these listeners.
  for (const type of ['wheel', 'touchmove']) document.addEventListener(type, blockBackgroundScroll, { capture: true, passive: false, signal: scrollEvents.signal });
  frame.addEventListener('load', () => {
    if (!dialog.dataset.theme) dialog.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    // Keep the host's close button reachable even if the startup script failed.
    dialog.dataset.surfaceReady = '';
    frame.focus();
  }, { once: true });
  return { opened: true };
}
