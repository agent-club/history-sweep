// Product comparison navigation; no extension or browser-history APIs.
const picker = document.querySelector('#compare-picker');
if (picker) {
  const panels = [...document.querySelectorAll('[data-tool-panel]')];
  const known = new Set(panels.map(panel => panel.dataset.toolPanel));
  const initial = new URL(location.href).searchParams.get('tool');
  if (known.has(initial)) picker.value = initial;
  const render = () => {
    for (const panel of panels) panel.hidden = panel.dataset.toolPanel !== picker.value;
    document.querySelectorAll('.breadcrumb a,.compare-nav-active').forEach(link => {
      link.href = `./?vs=${picker.value}#compare`;
    });
  };
  picker.addEventListener('change', () => {
    render();
    const url = new URL(location.href);
    url.searchParams.set('tool', picker.value);
    history.replaceState(null, '', url);
  });
  render();
}

const method = document.querySelector('#method');
if (method) {
  const openMethod = () => { if (location.hash === '#method') method.open = true; };
  window.addEventListener('hashchange', openMethod);
  // Language rendering replaces inline links; delegate to the document.
  document.addEventListener('click', event => {
    if (event.target.closest('a[href="#method"]')) method.open = true;
  });
  openMethod();
}
