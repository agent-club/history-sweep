// This classic script runs before the application module graph is loaded.
(() => {
  const app = document.getElementById('app');
  const splash = document.getElementById('startup');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const started = performance.now();
  let revealing = false;
  let revealTimer;
  let exitTimer;
  let beforeReveal;
  let holdingNameplate = false;

  function finish() {
    clearTimeout(revealTimer); clearTimeout(exitTimer); clearTimeout(deadline);
    splash.remove();
    app.inert = false; app.removeAttribute('aria-busy');
    delete document.body.dataset.startup;
    document.removeEventListener('history-sweep:startup-ready', ready);
    document.removeEventListener('history-sweep:nameplate-collecting', collectNameplate);
    motion.removeEventListener('change', motionChanged);
    document.dispatchEvent(new Event('history-sweep:startup-dismissed'));
  }
  function reveal() {
    if (revealing) return;
    revealing = true;
    clearTimeout(deadline);
    // Open an opaque, preloaded card before revealing any part of the workspace.
    let closed;
    try { closed = beforeReveal?.(); } catch { /* A failed card surface must not block startup. */ }
    if (closed) {
      holdingNameplate = true;
      document.body.dataset.startup = 'nameplate';
      exitTimer = setTimeout(() => splash.remove(), motion.matches ? 0 : 180);
      Promise.resolve(closed).finally(finish);
      return;
    }
    document.body.dataset.startup = 'revealing';
    if (motion.matches) finish();
    else exitTimer = setTimeout(finish, 180);
  }
  function ready(event) {
    beforeReveal = event.detail?.beforeReveal;
    // Two frames let the initial results settle before exposing the workspace.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      revealTimer = setTimeout(reveal, motion.matches ? 0 : Math.max(0, 420 - (performance.now() - started)));
    }));
  }
  function motionChanged() {
    if (motion.matches && revealing && !holdingNameplate) finish();
  }
  function collectNameplate() {
    // The card stays modal/inert while its opaque background dissolves over the ready workspace.
    if (holdingNameplate) document.body.dataset.startup = 'collecting';
  }
  document.addEventListener('history-sweep:nameplate-collecting', collectNameplate);
  document.addEventListener('history-sweep:startup-ready', ready, { once: true });
  motion.addEventListener('change', motionChanged);
  // A slow or failed module must not leave the workspace permanently covered.
  const deadline = setTimeout(reveal, 5000);
})();
