// Page owners keep their drafts and decide when closing is allowed.
export function setupSettingsTabs(root, { label, moreLabel, closeLabel, onEmpty, isBusy }) {
  const strip = root.querySelector('.settings-tabs-list');
  const more = root.querySelector('.settings-tabs-more');
  const menu = root.querySelector('.settings-tabs-menu');
  const pages = new Map();
  const events = new AbortController();
  let active = null;
  let frame = 0;
  const tabVisibility = new IntersectionObserver(entries => {
    for (const { target, intersectionRect, boundingClientRect } of entries) {
      target.toggleAttribute('data-clipped', intersectionRect.width < boundingClientRect.width - 0.5);
    }
  }, { root: strip, threshold: 1 });
  strip.setAttribute('aria-label', label);
  more.setAttribute('aria-label', moreLabel);
  more.title = moreLabel;
  menu.setAttribute('aria-label', moreLabel);

  function closeMenu(restoreFocus = false) {
    menu.hidden = true;
    more.setAttribute('aria-expanded', 'false');
    if (restoreFocus) more.focus({ preventScroll: true });
  }
  function measure() {
    const overflow = strip.scrollWidth > root.clientWidth + 1;
    more.hidden = !overflow;
    root.dataset.overflow = String(overflow);
    if (!overflow) closeMenu();
  }
  function reveal(id) {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      measure();
      const tab = pages.get(id)?.node;
      if (!tab) return;
      const viewport = strip.getBoundingClientRect(), bounds = tab.getBoundingClientRect();
      const delta = bounds.left < viewport.left ? bounds.left - viewport.left : bounds.right > viewport.right ? bounds.right - viewport.right : 0;
      if(tab === strip.firstElementChild) strip.scrollLeft=0;
      else if (delta) strip.scrollBy({ left: delta, behavior: 'auto' });
    });
  }
  function select(id, focus = false) {
    if (isBusy()) return;
    closeMenu();
    pages.get(id)?.activate();
    if (focus) pages.get(active)?.node.querySelector('[role=tab]').focus({ preventScroll: true });
  }
  function forget(ids) {
    for (const id of ids) {
      const page = pages.get(id);
      if (!page) continue;
      tabVisibility.unobserve(page.node);
      page.node.remove();
      pages.delete(id);
    }
    if (!menu.hidden) renderMenu();
    measure();
  }
  function close(id) {
    if (isBusy()) return;
    closeMenu();
    const page = pages.get(id);
    const order = [...pages.keys()], previousActive = active, index = order.indexOf(active);
    page?.close((ids = [id]) => {
      const removedActive = ids.includes(previousActive);
      forget(ids);
      if (!removedActive) { pages.get(active)?.node.querySelector('[role=tab]').focus({preventScroll:true});reveal(active);return; }
      const next = order.slice(0, index).reverse().find(key => pages.has(key)) || order.slice(index + 1).find(key => pages.has(key));
      // Let the owner's confirmation finish before moving focus to the next page.
      requestAnimationFrame(() => {
        if (next) select(next, true);
        else { active = null; onEmpty(); }
      });
    });
  }
  function closeButton(page) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'settings-tab-close';
    button.setAttribute('aria-label', closeLabel(page.title));
    button.title = closeLabel(page.title);
    const icon = document.createElement('img');
    icon.src = 'icons/ui/x.svg'; icon.alt = ''; icon.className = 'ui-icon';
    button.append(icon);
    button.addEventListener('click', () => close(page.id));
    return button;
  }
  function renderMenu() {
    menu.replaceChildren();
    for (const page of pages.values()) {
      const row = document.createElement('div'); row.className = 'settings-tabs-menu-row';
      const button = document.createElement('button'); button.type = 'button';
      button.className = 'settings-tabs-menu-page'; button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(page.id === active));
      button.textContent = page.title; button.title = page.title;
      button.addEventListener('click', () => select(page.id, true));
      const dismiss=closeButton(page);dismiss.setAttribute('role','menuitem');
      row.append(button, dismiss); menu.append(row);
    }
  }
  function visit(descriptor) {
    let page = pages.get(descriptor.id);
    if (!page) {
      const node = document.createElement('div'); node.className = 'settings-tab'; node.dataset.settingsTab = descriptor.id;
      const button = document.createElement('button'); button.type = 'button'; button.className = 'settings-tab-select';
      button.id = `settings-tab-${descriptor.id}`; button.setAttribute('role', 'tab');
      button.addEventListener('click', () => select(descriptor.id));
      node.append(button, closeButton(descriptor)); strip.append(node);
      tabVisibility.observe(node);
      page = { ...descriptor, node }; pages.set(descriptor.id, page);
    }
    Object.assign(page, descriptor);
    active = page.id;
    for (const entry of pages.values()) {
      const selected = entry.id === active, button = entry.node.querySelector('[role=tab]');
      entry.node.dataset.active = String(selected);
      button.textContent = entry.title; button.title = entry.title;
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      if (entry.panelId) {
        button.setAttribute('aria-controls', entry.panelId);
        const panel = document.getElementById(entry.panelId);
        panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
      }
      const dismiss = entry.node.querySelector('.settings-tab-close');
      dismiss.setAttribute('aria-label', closeLabel(entry.title)); dismiss.title = closeLabel(entry.title);
    }
    if (!menu.hidden) renderMenu();
    reveal(active);
  }
  more.addEventListener('click', () => {
    if (!menu.hidden) { closeMenu(true); return; }
    renderMenu(); menu.hidden = false; more.setAttribute('aria-expanded', 'true');
    menu.querySelector('[aria-checked=true]')?.focus({ preventScroll: true });
  }, { signal: events.signal });
  strip.addEventListener('wheel', event => {
    if (strip.scrollWidth <= strip.clientWidth + 1 || event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? strip.clientWidth : 1);
    strip.scrollLeft += delta; event.preventDefault();
  }, { passive: false, signal: events.signal });
  strip.addEventListener('focusin', event => {
    const clipped = event.target.closest('.settings-tab[data-clipped]');
    if (clipped) reveal(clipped.dataset.settingsTab);
  }, { signal: events.signal });
  strip.addEventListener('keydown', event => {
    const current = event.target.closest('[role=tab]');
    if (!current) return;
    const order = [...pages.keys()], index = order.indexOf(current.parentElement.dataset.settingsTab);
    let next;
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length];
    if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length];
    if (event.key === 'Home') next = order[0];
    if (event.key === 'End') next = order.at(-1);
    if (event.key === 'Delete') { event.preventDefault(); close(order[index]); }
    if (next) { event.preventDefault(); select(next, true); }
  }, { signal: events.signal });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...menu.querySelectorAll('[role=menuitemradio]')], index = items.indexOf(document.activeElement);
    const target = event.key === 'Home' ? items[0] : event.key === 'End' ? items.at(-1) : items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    event.preventDefault(); target?.focus();
  }, { signal: events.signal });
  const resize = new ResizeObserver(() => { measure(); reveal(active); });
  resize.observe(strip);
  return { visit, forget, close, closeMenu,
    isMenuOpen: () => !menu.hidden, contains: target => root.contains(target),
    destroy() { events.abort(); resize.disconnect(); tabVisibility.disconnect(); cancelAnimationFrame(frame); closeMenu(); },
  };
}
