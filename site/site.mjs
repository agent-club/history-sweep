const languageSwitch = document.getElementById('language');
const languageButtons = [...languageSwitch.querySelectorAll('[data-language]')];
let language = 'en';
try { language = localStorage.getItem('language') === 'zh-CN' ? 'zh-CN' : 'en'; } catch {}
const nodes = [...document.querySelectorAll('[data-zh]')].map(node => ({ node, en: node.innerHTML, zh: node.dataset.zh }));
const images = [...document.querySelectorAll('[data-zh-alt]')].map(node => ({ node, en: node.alt, zh: node.dataset.zhAlt }));
const openingController = createOpeningController();
function render() {
  document.documentElement.lang = language;
  languageSwitch.setAttribute('aria-label', language === 'zh-CN' ? '语言' : 'Language');
  for (const button of languageButtons) button.setAttribute('aria-pressed', String(button.dataset.language === language));
  for (const { node, en, zh } of nodes) node.innerHTML = language === 'zh-CN' ? zh : en;
  for (const { node, en, zh } of images) node.alt = language === 'zh-CN' ? zh : en;
  document.querySelectorAll('img[src*="popup-"],img[src*="manager-"]').forEach(img => { img.src = img.src.replace(/-(en|zh)\.png/, language === 'zh-CN' ? '-zh.png' : '-en.png'); });
  openingController?.render(language);
}
for (const button of languageButtons) {
  button.addEventListener('click', () => {
    language = button.dataset.language;
    try { localStorage.setItem('language', language); } catch {}
    render();
  });
}

function createOpeningController() {
  const video = document.getElementById('opening-video');
  if (!video) return null;
  const stage = document.getElementById('opening');
  const toggle = document.getElementById('opening-toggle');
  const timer = stage.querySelector('.film-time');
  const chapters = [...stage.querySelectorAll('[data-opening-time]')];
  const chapterGroup = stage.querySelector('.film-chapters');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let currentLanguage;
  let visible = false;
  let wantsPlayback = !reducedMotion.matches;
  let finished = false;
  let seekTime = 0;
  let failed = false;
  video.muted = true;

  function updateControls() {
    const zh = currentLanguage === 'zh-CN';
    const label = failed ? (zh ? '短片暂不可用' : 'Film unavailable')
      : finished ? (zh ? '再看一次' : 'Replay film')
      : video.paused ? (zh ? '播放短片' : 'Play film')
      : (zh ? '暂停短片' : 'Pause film');
    toggle.textContent = label;
    toggle.disabled = failed;
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = finished ? '↻' : video.paused ? '▷' : 'Ⅱ';
    if (!failed) toggle.append(icon);
    const time = finished ? 9 : Math.min(video.currentTime || 0, 9);
    timer.replaceChildren(`00:${String(Math.floor(time)).padStart(2, '0')} `);
    const duration = document.createElement('span');
    duration.textContent = '/ 00:09';
    timer.append(duration);
    stage.style.setProperty('--film-progress', String(time / 9));
    const active = chapters.findLastIndex(button => time >= Number(button.dataset.openingTime));
    chapters.forEach((button, index) => button.setAttribute('aria-pressed', String(!finished && index === active)));
  }

  function reconcilePlayback() {
    // A finite intro resumes after scrolling back, but never after an explicit pause or its ending.
    if (wantsPlayback && visible && !document.hidden && !finished && !failed) {
      const source = video.src;
      video.play().catch(error => {
        // Changing source or pausing offscreen can abort an otherwise valid play request.
        if (source !== video.src || error.name === 'AbortError') return;
        wantsPlayback = false;
        updateControls();
      });
    } else {
      video.pause();
    }
    updateControls();
  }

  video.addEventListener('loadedmetadata', () => {
    video.currentTime = Math.min(seekTime, Math.max(0, video.duration - 1 / 30));
    reconcilePlayback();
  });
  video.addEventListener('timeupdate', updateControls);
  video.addEventListener('seeked', updateControls);
  video.addEventListener('play', updateControls);
  video.addEventListener('pause', updateControls);
  video.addEventListener('ended', () => {
    finished = true;
    wantsPlayback = false;
    updateControls();
  });
  video.addEventListener('error', () => { failed = true; wantsPlayback = false; updateControls(); });
  toggle.addEventListener('click', () => {
    if (finished) {
      finished = false;
      video.currentTime = 0;
      wantsPlayback = true;
    } else {
      wantsPlayback = video.paused;
    }
    reconcilePlayback();
  });
  for (const chapter of chapters) {
    chapter.addEventListener('click', () => {
      finished = false;
      seekTime = Number(chapter.dataset.openingTime);
      if (video.readyState >= 1) video.currentTime = seekTime;
      else video.load();
      // Chapter navigation is an explicit request to play, including with reduced motion enabled.
      wantsPlayback = true;
      reconcilePlayback();
    });
  }
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    reconcilePlayback();
  }, { threshold: 0.2 }).observe(video);
  document.addEventListener('visibilitychange', reconcilePlayback);
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { wantsPlayback = false; reconcilePlayback(); }
  });

  return {
    render(nextLanguage) {
      chapterGroup.setAttribute('aria-label', nextLanguage === 'zh-CN' ? '选择功能演示章节' : 'Explore the demonstration');
      video.setAttribute('aria-label', nextLanguage === 'zh-CN' ? 'History Sweep 九秒功能演示' : 'A nine-second History Sweep feature demonstration');
      if (currentLanguage !== nextLanguage) {
        // Keep the same moment and the visitor's playback choice when changing language.
        seekTime = currentLanguage ? video.currentTime : 0;
        currentLanguage = nextLanguage;
        failed = false;
        const suffix = nextLanguage === 'zh-CN' ? 'zh' : 'en';
        video.poster = `assets/opening-${suffix}.png`;
        video.preload = reducedMotion.matches ? 'none' : 'metadata';
        video.src = `assets/opening-${suffix}.mp4`;
      }
      updateControls();
    },
  };
}
render();
