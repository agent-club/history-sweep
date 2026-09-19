import en from './locales/en.mjs';
import zh from './locales/zh-CN.mjs';
export const dictionaries = { en, 'zh-CN': zh };
export function translate(lang, key, values = {}) {
  return (dictionaries[lang]?.[key] ?? en[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}
export function readLanguage() {
  try { return localStorage.getItem('language') === 'zh-CN' ? 'zh-CN' : 'en'; } catch { return 'en'; }
}
export function saveLanguage(lang) { try { localStorage.setItem('language', lang); } catch {} }
