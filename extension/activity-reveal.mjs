// Owns explicit disclosure only; activity data and privacy remain in activity-panel.
export function createActivityReveal({ opened, onChange, signal }) {
  const root = document.getElementById('activityPanel');
  const dock = document.getElementById('activityDock');
  const entry = document.getElementById('activityEntry');
  const collapse = document.getElementById('activityCollapse');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const listen = (target, type, callback) => target.addEventListener(type, callback, { signal });
  let expanded = opened, timer, focusAfterOpen = false;

  function finish() {
    clearTimeout(timer);
    dock.dataset.settled = 'true';
    root.hidden = !expanded; root.inert = !expanded;
    entry.hidden = expanded; entry.inert = expanded;
    dock.style.removeProperty('height');
    dock.style.removeProperty('--activity-duration');
    if (expanded && focusAfterOpen && [entry, document.body].includes(document.activeElement)) collapse.focus({ preventScroll: true });
    focusAfterOpen = false;
  }

  function setExpanded(value) {
    const currentHeight = dock.getBoundingClientRect().height;
    clearTimeout(timer);
    dock.style.height = `${currentHeight}px`;
    focusAfterOpen = value && document.activeElement === entry;
    expanded = value;
    root.hidden = false; entry.hidden = false;
    entry.inert = value;
    if (!value && root.contains(document.activeElement)) entry.focus({ preventScroll: true });
    root.inert = true;
    dock.dataset.open = String(value); dock.dataset.settled = 'false';
    entry.setAttribute('aria-expanded', String(value));
    // Render cached content or its loading chart before measuring the disclosed height.
    onChange(value, { commit: true });
    const minimum = parseFloat(getComputedStyle(dock).minHeight);
    const target = value ? Math.max(minimum, root.offsetHeight) : minimum;
    const duration = value ? 280 : 220;
    dock.style.setProperty('--activity-duration', `${duration}ms`);
    dock.getBoundingClientRect();
    dock.style.height = `${target}px`;
    root.style.opacity = value ? '1' : '0';
    entry.style.opacity = value ? '0' : '1';
    if (motion.matches || Math.abs(target - currentHeight) < 1) finish();
    else timer = setTimeout(finish, duration + 60);
  }

  dock.dataset.open = String(expanded);
  entry.setAttribute('aria-expanded', String(expanded));
  root.style.opacity = expanded ? '1' : '0'; entry.style.opacity = expanded ? '0' : '1';
  finish();
  listen(dock, 'transitionend', event => {
    if (event.target === dock && event.propertyName === 'height') finish();
  });
  listen(entry, 'click', () => setExpanded(true));
  listen(collapse, 'click', () => setExpanded(false));
  listen(entry, 'keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setExpanded(true); }
  });
  listen(root, 'keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); setExpanded(false);
  });
  listen(motion, 'change', () => { if (motion.matches) finish(); });
  const size = new ResizeObserver(entries => {
    if (expanded && dock.dataset.settled !== 'true') dock.style.height = `${entries[0].borderBoxSize[0].blockSize}px`;
  });
  size.observe(root);
  signal.addEventListener('abort', () => { clearTimeout(timer); size.disconnect(); }, { once: true });
}
