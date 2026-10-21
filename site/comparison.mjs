import {comparisonClaims, comparisonProducts} from './comparison-data.mjs';
import {featureImages} from './comparison-images.mjs';

const root = document.querySelector('[data-comparison]');
if (root) {
  const panel = root.querySelector('.vs-category');
  const deck = panel.querySelector('.rival-deck');
  const frontCard = deck.querySelector('.category-window');
  const cards = [...deck.querySelectorAll('[data-vs-tool]')];
  const previous = root.querySelector('[data-deck-prev]');
  const next = root.querySelector('[data-deck-next]');
  const motionToggle = root.querySelector('[data-vs-motion]');
  const arena = root.querySelector('.vs-arena');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const known = new Map(comparisonProducts.map(product => [product.key, product]));
  const requested = new URL(location.href).searchParams.get('vs');
  let selected = known.has(requested) ? requested : 'betterhistory';
  let requestedSelection = selected;
  let pendingDirection = 1;
  let dealing = false;
  let activeAnimation;
  let paused = false;

  function render() {
    const product = known.get(selected);
    const claims = comparisonClaims[selected];
    const language = document.documentElement.lang === 'zh-CN' ? 1 : 0;
    const frontIndex = comparisonProducts.findIndex(item => item.key === selected);
    panel.querySelectorAll('[data-vs-name]').forEach(node => { node.textContent = product.name; });
    panel.querySelector('[data-vs-maker]').textContent = product.maker;
    panel.querySelector('[data-vs-users]').textContent = `${product.users} users`;
    panel.querySelector('[data-battle-tagline]').textContent = claims.tagline[language];
    panel.querySelector('[data-battle-caption]').textContent = claims.caption[language];
    panel.querySelector('[data-battle-source]').href = claims.source;
    claims.rows.forEach((row, index) => {
      panel.querySelector(`[data-battle-main="${index}"]`).textContent = row[0][language];
      panel.querySelector(`[data-battle-note="${index}"]`).textContent = row[1][language];
    });
    cards.forEach((card, index) => {
      const slot = (index - frontIndex + cards.length) % cards.length;
      card.dataset.deckSlot = String(slot);
      card.hidden = slot === 0;
      card.setAttribute('aria-pressed', String(slot === 0));
      const name = comparisonProducts[index].name;
      card.setAttribute('aria-label', language ? `与 ${name} 对比` : `Compare with ${name}`);
    });
    for (const [button, en, zh] of [[previous, 'Previous competitor card', '上一张竞品卡片'], [next, 'Next competitor card', '下一张竞品卡片']]) {
      button.setAttribute('aria-label', language ? zh : en);
      button.title = language ? zh : en;
    }
    root.querySelector('.deck-controls').setAttribute('aria-label', language ? `切换竞品，当前为 ${product.name}` : `Switch competitor, currently ${product.name}`);
    root.querySelector('[data-deck-current]').textContent = product.name;
    root.querySelector('[data-deck-count]').textContent = `${String(frontIndex + 1).padStart(2, '0')} / ${String(cards.length).padStart(2, '0')}`;
    root.querySelector('.vs-research-link a').href = `compare.html?tool=${selected}`;
    const images = featureImages(selected, language);
    root.querySelectorAll('[data-feature-side]').forEach(figure => {
      const own = figure.dataset.featureSide === 'own';
      const index = Number(figure.dataset.featureIndex);
      const item = images[own ? 'own' : 'rival'][index];
      const image = figure.querySelector('img');
      image.src = item.src;
      image.dataset.photo = String(item.photo);
      image.alt = `${own ? 'History Sweep' : product.name} · ${index + 1} · ${item.kind}`;
      figure.querySelector('figcaption').textContent = item.kind;
      figure.querySelector('button').setAttribute('aria-label', `${language ? '放大' : 'Enlarge'} ${image.alt}`);
    });
    motionToggle.setAttribute('aria-pressed', String(paused));
    motionToggle.querySelector('span').textContent = language ? (paused ? '播放动效' : '暂停动效') : (paused ? 'Play motion' : 'Pause motion');
  }

  const motionAllowed = () => !reducedMotion.matches && !paused;
  function settleMotion() {
    if (!motionAllowed()) activeAnimation?.finish();
  }
  motionToggle.addEventListener('click', () => {
    paused = !paused;
    arena.dataset.paused = String(paused);
    render();
    settleMotion();
  });
  reducedMotion.addEventListener('change', settleMotion);

  function commitProduct(key) {
    selected = key;
    render();
    const url = new URL(location.href);
    url.searchParams.set('vs', key);
    history.replaceState(null, '', url);
  }
  async function animateCard(frames, options) {
    const animation = frontCard.animate(frames, {...options, fill: 'both'});
    activeAnimation = animation;
    try { await animation.finished; } finally {
      animation.cancel();
      if (activeAnimation === animation) activeAnimation = undefined;
    }
  }
  async function dealCards() {
    dealing = true;
    try {
      // Finish the current deal, then honor the latest requested position.
      while (requestedSelection !== selected) {
        const target = requestedSelection;
        const direction = pendingDirection;
        if (!motionAllowed()) {
          commitProduct(target);
          continue;
        }
        const base = getComputedStyle(frontCard).transform;
        const oldOrigin = frontCard.style.transformOrigin;
        const rect = frontCard.getBoundingClientRect();
        const visibleStart = Math.max(0, -rect.top);
        const visibleHeight = Math.min(rect.height, innerHeight - Math.max(0, rect.top));
        // Pivot near the visible part of the long comparison, including after scrolling.
        frontCard.style.transformOrigin = `50% ${visibleStart + Math.max(0, Math.min(160, visibleHeight * .3))}px`;
        deck.classList.add('is-dealing');
        deck.setAttribute('aria-busy', 'true');
        try {
          await animateCard([
            {transform: base, opacity: 1},
            {transform: `${base} translate3d(${direction * 32}px,-22px,0) rotate(${direction * 3}deg) scale(.99)`, opacity: 1, offset: .45},
            {transform: `${base} translate3d(${direction * 128}px,-12px,0) rotate(${direction * 9}deg) scale(.94)`, opacity: 0},
          ], {duration: 280, easing: 'cubic-bezier(.4,0,.8,.4)'});
          commitProduct(target);
          if (motionAllowed()) {
            await animateCard([
              {transform: `${base} translate3d(${-direction * 42}px,22px,0) rotate(${-direction * 5}deg) scale(.96)`, opacity: .5},
              {transform: `${base} translate3d(${direction * 3}px,-5px,0) rotate(${direction * .6}deg) scale(1.005)`, opacity: 1, offset: .72},
              {transform: base, opacity: 1},
            ], {duration: 460, easing: 'cubic-bezier(.16,1,.3,1)'});
          }
        } finally {
          frontCard.style.transformOrigin = oldOrigin;
          deck.classList.remove('is-dealing');
          deck.removeAttribute('aria-busy');
        }
      }
    } finally { dealing = false; }
  }
  function chooseProduct(key, direction = 1) {
    requestedSelection = key;
    pendingDirection = direction;
    if (!dealing) void dealCards();
  }
  function advanceDeck(offset) {
    const index = comparisonProducts.findIndex(product => product.key === requestedSelection);
    chooseProduct(comparisonProducts[(index + offset + cards.length) % cards.length].key, offset);
  }
  previous.addEventListener('click', () => advanceDeck(-1));
  next.addEventListener('click', () => advanceDeck(1));
  cards.forEach(card => card.addEventListener('click', () => {
    chooseProduct(card.dataset.vsTool);
    next.focus({preventScroll: true});
  }));
  panel.addEventListener('keydown', event => {
    if (!event.target.closest('.deck-controls,.rival-deck')) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      advanceDeck(event.key === 'ArrowRight' ? 1 : -1);
      next.focus({preventScroll: true});
    }
  });

  const dialog = root.querySelector('[data-image-dialog]');
  let imageOpener;
  root.addEventListener('click', event => {
    const button = event.target.closest('[data-expand-image]');
    if (!button) return;
    imageOpener = button;
    const image = button.querySelector('img');
    const expanded = dialog.querySelector('img');
    expanded.src = image.src;
    expanded.alt = image.alt;
    dialog.querySelector('[data-image-caption]').textContent = button.closest('figure').querySelector('figcaption').textContent;
    dialog.showModal();
  });
  dialog.querySelector('[data-close-image]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => imageOpener?.focus({preventScroll: true}));
  new MutationObserver(render).observe(document.documentElement, {attributes: true, attributeFilter: ['lang']});
  render();
}
