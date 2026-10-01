import { createSuggestionIndex } from './history-suggestions.mjs';

let generation = 0; let indexPromise; let latestRequest = 0;
self.onmessage = event => {
  const message = event.data;
  if (message.type === 'index') {
    const current = ++generation;
    indexPromise = createSuggestionIndex(message.items, async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (current !== generation) throw new Error('SUPERSEDED');
    });
    indexPromise.catch(() => {});
  } else if (message.type === 'suggest') {
    latestRequest = message.id;
    const current = generation;
    indexPromise?.then(index => {
      if (current === generation && message.id === latestRequest) self.postMessage({ id: message.id, ...index.suggest(message.query, message.mode) });
    }).catch(() => {
      if (current === generation) self.postMessage({ id: message.id, suggestions: [] });
    });
  }
};
