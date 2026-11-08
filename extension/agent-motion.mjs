export const agentWorkKey = 'agentMcpWorking';

export const agentRobotIcon = `<svg class="agent-motion-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <g class="agent-robot-body"><rect x="4" y="6" width="16" height="12" rx="3"/><path d="M12 3v3m-4 12v3m8-3v3"/>
  <g class="agent-robot-eyes"><path class="agent-robot-eye" d="M8.5 11v2"/><path class="agent-robot-eye agent-robot-wink" d="M15.5 11v2"/></g>
  <path class="agent-robot-smile" d="M7.5 12q1-1.5 2 0m5 0q1-1.5 2 0m-6.5 2q2 2 4 0"/>
  <circle class="agent-robot-signal" cx="12" cy="3" r="2"/></g>
  <g class="agent-robot-ticket"><path d="M15 15h4l2 2v4h-6z" fill="currentColor" stroke="var(--agent-ticket-outline)" stroke-width="1.25"/>
  <path d="M16.5 17.4h2.7m-2.7 1.8h1.6" stroke="var(--agent-ticket-outline)" stroke-width="1"/></g>
</svg>`;

export const agentScanIcon = `<svg class="agent-motion-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path class="agent-scan-guide" d="M6 7H3v3m15-3h3v3M3 14v3h3m12 0h3v-3" opacity=".62"/>
  <path class="agent-scan-sheet" d="M8 4h6l3 3v13H8zM14 4v4h3m-7 4h5m-5 3h3"/>
  <path class="agent-scan-beam" d="M4 8h16" stroke-width="2"/>
  <g class="agent-scan-seal"><circle cx="17.5" cy="17.5" r="5" fill="currentColor" stroke="var(--agent-seal-contrast)"/><path d="m15.5 17.5 1.3 1.3 2.4-2.6" stroke="var(--agent-seal-contrast)" stroke-width="1.35"/></g>
</svg>`;

export const agentApprovalIcon = `<svg class="agent-motion-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M6 3h7l4 4v3m0 8v3H6zM13 3v5h4m-8 4h3m-3 4h1m2 1 1-3 6-6 2 2-6 6z"/>
</svg>`;

const idleTricks = ['tilt', 'peek', 'hop', 'grin'];

export function setupAgentIdleTricks(indicators, preferences, signal) {
  const [toolbar, badge] = indicators;
  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  const visibleIndicator = () => preferences.open ? badge : toolbar;
  let timer;
  let previousTrick;

  function canPlay(indicator) {
    return motion.matches && !document.hidden && !indicator.matches('[data-agent-working], [data-agent-catching]');
  }

  function play() {
    const indicator = visibleIndicator();
    if (!canPlay(indicator)) return;
    const choices = idleTricks.filter(trick => trick !== previousTrick);
    previousTrick = choices[Math.floor(Math.random() * choices.length)];
    indicator.dataset.agentIdleTrick = previousTrick;
    timer = setTimeout(play, 4500 + Math.random() * 3500);
  }

  function sync() {
    clearTimeout(timer);
    for (const indicator of indicators) delete indicator.dataset.agentIdleTrick;
    if (canPlay(visibleIndicator())) timer = setTimeout(play, 2200 + Math.random() * 1400);
  }

  preferences.addEventListener('toggle', sync, { signal });
  document.addEventListener('visibilitychange', sync, { signal });
  motion.addEventListener('change', sync, { signal });
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return sync;
}

export function watchAgentWork(api, onWork, signal) {
  const storage = api.storage;
  if (!storage?.session || !storage.onChanged || signal.aborted) return;
  let receivedChange = false;
  const change = (changes, area) => {
    if (area !== 'session' || !Object.hasOwn(changes, agentWorkKey)) return;
    receivedChange = true;
    onWork(changes[agentWorkKey].newValue === true);
  };
  storage.onChanged.addListener(change);
  signal.addEventListener('abort', () => storage.onChanged.removeListener?.(change), { once: true });
  void storage.session.get(agentWorkKey).then(saved => {
    if (!signal.aborted && !receivedChange) onWork(saved[agentWorkKey] === true);
  }).catch(() => {});
}
