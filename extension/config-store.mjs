import { CONFIG_KEY, CONNECTION_KEY, validateConfig, validateConnection } from './config-sync.mjs';

export function createConfigStore(storage, local) {
  return {
    async read() {
      const saved = await storage.get(['launchMode', CONFIG_KEY]);
      const metadata = saved[CONFIG_KEY] === undefined ? { historyTags: {}, domainLabels: {} } : saved[CONFIG_KEY];
      return validateConfig({ format: 'history-sweep-config', version: 1,
        preferences: { language: local.getItem('language') ?? 'en', theme: local.getItem('theme') ?? 'system', launchMode: saved.launchMode ?? 'modal' },
        historyTags: metadata.historyTags, domainLabels: metadata.domainLabels });
    },
    async connection() {
      const saved = await storage.get(CONNECTION_KEY);
      return saved[CONNECTION_KEY] === undefined ? null : validateConnection(saved[CONNECTION_KEY]);
    },
    async saveConnection(value) { await storage.set({ [CONNECTION_KEY]: validateConnection(value) }); },
    async apply(value, connection) {
      const clean = validateConfig(value);
      const oldLanguage = local.getItem('language'); const oldTheme = local.getItem('theme');
      const update = { launchMode: clean.preferences.launchMode, [CONFIG_KEY]: { historyTags: clean.historyTags, domainLabels: clean.domainLabels } };
      if (connection !== undefined && connection !== null) update[CONNECTION_KEY] = validateConnection(connection);
      try {
        local.setItem('language', clean.preferences.language); local.setItem('theme', clean.preferences.theme);
        await storage.set(update);
      } catch (error) {
        try {
          for (const [key, old] of [['language', oldLanguage], ['theme', oldTheme]]) {
            if (old === null) local.removeItem(key); else local.setItem(key, old);
          }
        } catch {}
        throw error;
      }
      // A backup with no connection leaves an existing connection unchanged.
      return clean;
    },
  };
}
