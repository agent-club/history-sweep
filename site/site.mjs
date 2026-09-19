const languageSwitch = document.getElementById('language');
const languageButtons = [...languageSwitch.querySelectorAll('[data-language]')];
let language = 'en';
try { language = localStorage.getItem('language') === 'zh-CN' ? 'zh-CN' : 'en'; } catch {}
const nodes = [...document.querySelectorAll('[data-zh]')].map(node => ({ node, en: node.innerHTML, zh: node.dataset.zh }));
const images = [...document.querySelectorAll('[data-zh-alt]')].map(node => ({ node, en: node.alt, zh: node.dataset.zhAlt }));
function render() {
  document.documentElement.lang = language;
  languageSwitch.setAttribute('aria-label', language === 'zh-CN' ? '语言' : 'Language');
  for (const button of languageButtons) button.setAttribute('aria-pressed', String(button.dataset.language === language));
  for (const { node, en, zh } of nodes) node.innerHTML = language === 'zh-CN' ? zh : en;
  for (const { node, en, zh } of images) node.alt = language === 'zh-CN' ? zh : en;
  document.querySelectorAll('img[src*="popup-"],img[src*="manager-"]').forEach(img => { img.src = img.src.replace(/-(en|zh)\.png/, language === 'zh-CN' ? '-zh.png' : '-en.png'); });
}
for (const button of languageButtons) {
  button.addEventListener('click', () => {
    language = button.dataset.language;
    try { localStorage.setItem('language', language); } catch {}
    render();
  });
}
render();
