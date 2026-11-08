import { translate } from './i18n.mjs';

let nextHelpId = 0;

export function addPreferenceHelp(anchor, lang, label, ...content) {
  const doc = anchor.ownerDocument;
  const legend = anchor.closest('legend');
  const row = doc.createElement(legend ? 'span' : 'div');
  row.className = 'preference-help-heading preference-help-title';
  anchor.before(row);

  const panel = doc.createElement('div');
  panel.id = `preference-help-${++nextHelpId}`;
  panel.className = 'preference-help-panel';
  panel.hidden = true;
  panel.tabIndex = 0;
  for (const item of content) {
    if (typeof item !== 'string') {
      panel.append(item);
    } else {
      const paragraph = doc.createElement('p');
      paragraph.textContent = item;
      panel.append(paragraph);
    }
  }

  const trigger = doc.createElement('button');
  trigger.type = 'button';
  trigger.className = 'preference-help-trigger';
  trigger.setAttribute('aria-label', translate(lang, 'preferenceHelpFor', { label }));
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', panel.id);
  trigger.setAttribute('aria-describedby', panel.id);
  const icon = doc.createElement('img');
  icon.className = 'ui-icon';
  icon.src = 'icons/ui/question.svg';
  icon.alt = '';
  trigger.append(icon);
  row.append(anchor, trigger);
  if (legend) legend.after(panel);
  else row.append(panel);
  return panel;
}

const triggerSelector = '.preference-help-trigger';
const activeTrigger = root => root.querySelector(`${triggerSelector}[aria-expanded="true"]`);
const controlledPanel = trigger => trigger.ownerDocument.getElementById(trigger.getAttribute('aria-controls'));

export function closePreferenceHelp(root, restoreFocus = false) {
  const trigger = activeTrigger(root);
  if (!trigger) return;
  controlledPanel(trigger).hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  if (restoreFocus) trigger.focus({ preventScroll: true });
}

export function preferenceHelpLayer(root) {
  const trigger = activeTrigger(root);
  if (!trigger) return null;
  const panel = controlledPanel(trigger);
  return {
    contains: target => trigger.contains(target) || panel.contains(target),
    close: () => closePreferenceHelp(root, true),
  };
}

export function setupPreferenceHelp(root, { signal, standalone = false } = {}) {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  const listen = (target, type, fn, capture = false) => target.addEventListener(type, fn, { signal, capture });
  function position(trigger, scrollArea) {
    const anchor = trigger.getBoundingClientRect();
    const bounds = root.matches('dialog') ? root.getBoundingClientRect() : {
      left: 0, top: 0, right: doc.documentElement.clientWidth, bottom: doc.documentElement.clientHeight,
    };
    if (!anchor.width || anchor.bottom <= bounds.top || anchor.top >= bounds.bottom ||
        (scrollArea && (anchor.top < scrollArea.top || anchor.bottom > scrollArea.bottom))) {
      closePreferenceHelp(root);
      return;
    }
    // Fixed positioning keeps the hint outside the scroll clip while it stays in the dialog's focus scope.
    const panel = controlledPanel(trigger);
    const inset = 12;
    const gap = 4;
    panel.style.width = `${Math.min(320, bounds.right - bounds.left - 2 * inset)}px`;
    const above = anchor.top - bounds.top - inset - gap;
    const below = bounds.bottom - anchor.bottom - inset - gap;
    const naturalHeight = panel.scrollHeight + panel.offsetHeight - panel.clientHeight;
    const upward = below < naturalHeight && above > below;
    panel.style.maxHeight = `${Math.max(0, upward ? above : below)}px`;
    panel.style.left = `${Math.max(bounds.left + inset, Math.min(anchor.left, bounds.right - inset - panel.offsetWidth))}px`;
    panel.style.top = `${upward ? anchor.top - gap - panel.offsetHeight : anchor.bottom + gap}px`;
  }

  listen(root, 'click', event => {
    const trigger = event.target.closest(triggerSelector);
    if (!trigger) return;
    const wasOpen = trigger === activeTrigger(root);
    closePreferenceHelp(root);
    if (wasOpen) return;
    controlledPanel(trigger).hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    position(trigger);
  });
  listen(root, 'focusin', event => {
    const layer = preferenceHelpLayer(root);
    if (layer && !layer.contains(event.target)) closePreferenceHelp(root);
  });
  listen(win, 'resize', () => {
    const trigger = activeTrigger(root);
    if (trigger) position(trigger);
  });
  listen(doc, 'scroll', event => {
    const trigger = activeTrigger(root);
    if (trigger && event.target.contains(trigger)) {
      position(trigger, event.target === doc ? undefined : event.target.getBoundingClientRect());
    }
  }, true);

  if (standalone) {
    listen(doc, 'pointerdown', event => {
      const layer = preferenceHelpLayer(root);
      if (layer && !layer.contains(event.target)) closePreferenceHelp(root);
    }, true);
    listen(doc, 'keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return;
      const layer = preferenceHelpLayer(root);
      if (!layer) return;
      layer.close();
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
}
