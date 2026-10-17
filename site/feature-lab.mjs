const tabs = [...document.querySelectorAll('[data-lab-tab]')];
const panels = [...document.querySelectorAll('[data-lab-panel]')];
const stage = document.querySelector('.lab-stage');
const tabList = document.querySelector('.lab-tabs');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const beam = document.createElement('span');
beam.className = 'lab-transition-beam';
beam.setAttribute('aria-hidden', 'true');
stage.append(beam);
const indicator = document.createElement('span');
indicator.className = 'lab-tab-indicator';
indicator.setAttribute('aria-hidden', 'true');
tabList.append(indicator);
let revision = 0;
let animations = [];

function moveIndicator(tab) {
  indicator.style.width = `${tab.offsetWidth}px`;
  indicator.style.transform = `translate(${tab.offsetLeft}px, ${tab.offsetTop + tab.offsetHeight - 2}px)`;
}

function animate(element, keyframes, options = {}) {
  const animation = element.animate(keyframes, {
    duration: 580, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both', ...options,
  });
  animations.push(animation);
  // Rapid scene changes cancel earlier runs; cancellation is an expected outcome.
  animation.finished.catch(() => {});
  return animation;
}

async function chooseScene(tab, focus = false) {
  const run = ++revision;
  const outgoing = panels.find(panel => !panel.hidden);
  const incoming = panels.find(panel => panel.dataset.labPanel === tab.dataset.labTab);
  const height = stage.getBoundingClientRect().height;
  const direction = panels.indexOf(incoming) >= panels.indexOf(outgoing) ? 1 : -1;
  for (const animation of animations) animation.cancel();
  animations = [];
  for (const panel of panels) { panel.inert = false; panel.removeAttribute('aria-hidden'); }
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  moveIndicator(tab);
  if (focus) tab.focus();
  if (reducedMotion.matches || incoming === outgoing) {
    for (const panel of panels) panel.hidden = panel !== incoming;
    stage.style.height = '';
    stage.dataset.motion = reducedMotion.matches ? 'reduced' : 'idle';
    return;
  }

  // Hold the stage while the old scene exits; only one panel is interactive at a time.
  stage.style.height = `${height}px`;
  stage.dataset.motion = 'leaving';
  outgoing.inert = true;
  outgoing.setAttribute('aria-hidden', 'true');
  await animate(outgoing, [
    {opacity: 1, transform: 'translateX(0) scale(1)'},
    {opacity: 0, transform: `translateX(${-direction * 24}px) scale(.985)`},
  ], {duration: 160, easing: 'cubic-bezier(.4,0,1,1)'}).finished.catch(() => {});
  if (run !== revision) return;

  for (const panel of panels) {
    panel.hidden = panel !== incoming;
    panel.inert = false;
    panel.removeAttribute('aria-hidden');
  }
  stage.dataset.motion = 'entering';
  const nextHeight = incoming.offsetHeight + 2;
  animate(stage, [{height: `${height}px`}, {height: `${nextHeight}px`}], {duration: 520});
  animate(beam, [
    {transform: `translateX(${direction > 0 ? -80 : stage.clientWidth + 80}px) skewX(-16deg)`, opacity: 0},
    {opacity: .75, offset: .2},
    {opacity: .3, offset: .7},
    {transform: `translateX(${direction > 0 ? stage.clientWidth + 80 : -80}px) skewX(-16deg)`, opacity: 0},
  ], {duration: 700, easing: 'cubic-bezier(.4,0,.2,1)'});
  [...incoming.querySelector('.lab-story').children].forEach((child, index) => {
    animate(child, [{opacity: 0, transform: 'translateY(24px)'}, {opacity: 1, transform: 'translateY(0)'}], {delay: 35 + index * 55});
  });
  animate(incoming.querySelector('.lab-interactive'), [
    {opacity: 0, transform: `perspective(1000px) translateX(${direction * 42}px) rotateY(${-direction * 5}deg) scale(.97)`},
    {opacity: 1, transform: 'perspective(1000px) translateX(0) rotateY(0) scale(1)'},
  ], {delay: 90, duration: 700});

  const scene = incoming.dataset.labPanel;
  if (scene === 'match' || scene === 'keep') {
    const rows = incoming.querySelectorAll(scene === 'match' ? '[data-match-row]' : '.keep-row');
    rows.forEach((row, index) => {
      const opacity = Number(getComputedStyle(row).opacity);
      const transform = getComputedStyle(row).transform;
      animate(row, [
        {opacity: 0, transform: `translateX(${30 + index * 8}px)`},
        {opacity, transform},
      ], {delay: 190 + index * 85, duration: 620});
    });
    if (scene === 'keep') animate(incoming.querySelector('.keep-totals'), [
      {opacity: 0, transform: 'translateY(14px) scale(.94)'},
      {opacity: 1, transform: 'translateY(0) scale(1)'},
    ], {delay: 440});
  } else if (scene === 'space') {
    const window = incoming.querySelector('.space-window');
    const base = getComputedStyle(window).transform;
    animate(window, [
      {transform: `${base === 'none' ? '' : base} translateY(32px) scale(.86) rotate(-3deg)`, opacity: 0},
      {transform: `${base === 'none' ? '' : base} translateY(-5px) scale(1.02) rotate(.4deg)`, opacity: 1, offset: .7},
      {transform: base, opacity: 1},
    ], {delay: 160, duration: 780});
  } else if (scene === 'check') {
    animate(incoming.querySelector('.verified-image'), [
      {clipPath: 'inset(0 100% 0 0)'}, {clipPath: 'inset(0 0% 0 0)'},
    ], {delay: 160, duration: 700});
    animate(incoming.querySelector('.verified-stamp'), [
      {opacity: 0, transform: 'translateY(12px) scale(.9)'},
      {opacity: 1, transform: 'translateY(0) scale(1)'},
    ], {delay: 520});
  }
  await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  if (run !== revision) return;
  for (const animation of animations) animation.cancel();
  animations = [];
  stage.style.height = '';
  stage.dataset.motion = 'idle';
}

stage.dataset.motion = reducedMotion.matches ? 'reduced' : 'idle';
new ResizeObserver(() => moveIndicator(tabs.find(tab => tab.getAttribute('aria-selected') === 'true'))).observe(tabList);
reducedMotion.addEventListener('change', () => chooseScene(tabs.find(tab => tab.getAttribute('aria-selected') === 'true')));

for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => chooseScene(tab));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    chooseScene(tabs[next], true);
  });
}

const matchButtons = [...document.querySelectorAll('[data-match-mode]')];
for (const button of matchButtons) button.addEventListener('click', () => {
  const mode = button.dataset.matchMode;
  for (const item of matchButtons) item.setAttribute('aria-pressed', String(item === button));
  for (const row of document.querySelectorAll('[data-match-row]')) {
    const included = mode === 'text' || row.dataset.matchRow === 'domain'
      || (mode === 'smart' && row.dataset.matchRow === 'subdomain');
    row.dataset.excluded = String(!included);
  }
  for (const copy of document.querySelectorAll('[data-match-copy]')) copy.hidden = copy.dataset.matchCopy !== mode;
});

const examples = [...document.querySelectorAll('[data-keep-example]')];
function updateExampleSelection() {
  const selected = examples.filter(input => input.checked).length;
  document.getElementById('lab-selected-count').textContent = selected;
  document.getElementById('lab-kept-count').textContent = examples.length - selected;
}
for (const input of examples) input.addEventListener('change', updateExampleSelection);
document.getElementById('lab-select-all').addEventListener('click', () => {
  for (const input of examples) input.checked = true;
  updateExampleSelection();
});

const spaces = [...document.querySelectorAll('[data-space]')];
for (const button of spaces) button.addEventListener('click', () => {
  for (const item of spaces) item.setAttribute('aria-pressed', String(item === button));
  document.querySelector('[data-space-view]').dataset.spaceView = button.dataset.space;
  for (const note of document.querySelectorAll('[data-space-note]')) note.hidden = note.dataset.spaceNote !== button.dataset.space;
});

function renderLabLanguage() {
  const zh = document.documentElement.lang === 'zh-CN';
  for (const node of document.querySelectorAll('[data-zh-aria]')) {
    if (!node.dataset.enAria) node.dataset.enAria = node.getAttribute('aria-label');
    node.setAttribute('aria-label', zh ? node.dataset.zhAria : node.dataset.enAria);
  }
  document.getElementById('lab-verified-image').src = `assets/product-verified-${zh ? 'zh' : 'en'}.png`;
}
new MutationObserver(renderLabLanguage).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
renderLabLanguage();
