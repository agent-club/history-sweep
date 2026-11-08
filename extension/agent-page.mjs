import { readLanguage } from './i18n.mjs';
import { agentCopy } from './agent-copy.mjs';
import { createInstallerDownload, macInstallerDefaultExtensionId, macInstallerUrl } from './agent-installers.mjs';
import { agentRelease } from './agent-release.mjs';
import { agentApprovalIcon, watchAgentWork } from './agent-motion.mjs';

import { agentMarkup } from './agent-view.mjs';
import { addPreferenceHelp, setupPreferenceHelp } from './preference-help.mjs';

export function mountAgentPage(root, { lang, send = message => chrome.runtime.sendMessage(message), standalone = false }) {
  const copy = agentCopy(lang);
  root.innerHTML = agentMarkup;
  root.querySelector('.agent-back').hidden = !standalone;
  for (const node of root.querySelectorAll('[data-copy]')) node.textContent = copy[node.dataset.copy];
  const $ = id => root.querySelector(`#${id}`);
  // Send only the visible example to the desktop composer.
  const launchPrompt = encodeURIComponent(copy.launchPrompt);
  $('openCodex').href = `codex://threads/new?prompt=${launchPrompt}`;
  $('openClaudeCode').href = `claude://code/new?q=${launchPrompt}`;
  $('openCodex').title = copy.openCodex;
  $('openClaudeCode').title = copy.openClaudeCode;
  addPreferenceHelp($('installHeading'), lang, copy.installTitle, copy.installBody, copy.installerDetails);
  addPreferenceHelp($('connectionHeading'), lang, copy.connectTitle, copy.setup, copy.instructions);
  addPreferenceHelp(root.querySelector('.agent-monitor'), lang, copy.automaticUpdates, root.querySelector('[data-copy="monitorDisclosure"]'));
  const lifecycle = new AbortController();
  const { signal } = lifecycle;
  if (standalone) setupPreferenceHelp(root, { signal, standalone: true });
  const updateField = (id, property, value) => {
    const node = $(id);
    if (node[property] !== value) node[property] = value;
  };
  let busy = false;
  let checkingUpdates = false;
  let checkedCurrent = false;
  const lastActions = new Map();
  let previous;
  let lastData;
  let refreshing = false;
  let actionGeneration = 0;
  let focusedRequest;
  const installerChoices = $('installerChoices').elements;
  installerChoices.namedItem('platform').value = /Win/i.test(navigator.platform) ? 'windows' : /Mac/i.test(navigator.platform) ? 'macos' : 'linux';
  const text = (parent, tag, value, className) => {
    const node = document.createElement(tag); node.textContent = value;
    if (className) node.className = className;
    parent.append(node); return node;
  };
  const time = value => new Intl.DateTimeFormat(lang, { dateStyle: 'medium', timeStyle: 'short' }).format(value);
  function renderUpdateStatus(health) {
    const update = health?.update;
    const button = $('checkUpdates');
    button.setAttribute('aria-busy', String(checkingUpdates));
    button.dataset.check = checkingUpdates ? 'checking' : checkedCurrent && update?.available === false && !update.error ? 'current' : 'idle';
    let summary = '';
    if (checkingUpdates) summary = copy.checkingUpdates;
    else if (update?.error) summary = copy.updateFailed;
    else if (update?.available) summary = `${copy.updateAvailable} ${update.latestVersion}`;
    else if (health?.restartRequired) summary = copy.updateInstalled;
    else if (update) summary = copy.upToDate;
    updateField('updateState', 'textContent', summary);
  }
  function render(data) {
    lastData = data;
    updateField('connectionState', 'textContent', data.connected ? copy.connected : copy.disconnected);
    $('connectionState').toggleAttribute('data-connected', data.connected);
    updateField('connect', 'textContent', data.profileId ? copy.reconnect : copy.connect);
    updateField('connect', 'hidden', data.connected);
    updateField('disconnect', 'hidden', !data.enabled);
    updateField('profile', 'hidden', !data.profileId);
    updateField('profileId', 'value', data.profileId ?? '');
    updateField('automaticUpdates', 'checked', data.checkUpdates);
    updateField('companionHealth', 'hidden', !data.companion);
    renderUpdateStatus(data.companion);
    if (data.companion) {
      const health = data.companion;
      const update = health.update;
      updateField('runningVersion', 'textContent', health.runningVersion);
      updateField('installedVersion', 'textContent', health.installedVersion);
      updateField('mcpLastRequest', 'textContent', health.mcpLastSeenAt ? time(Date.parse(health.mcpLastSeenAt)) : copy.mcpNeverSeen);
      updateField('skillHealth', 'textContent', !health.skillCount ? copy.skillMissing : health.skillHealthy ? copy.skillHealthy : copy.skillChanged);
      const skillNotice = !health.skillCount ? copy.skillMissingNotice : !health.skillHealthy ? copy.skillChangedNotice : '';
      updateField('skillNotice', 'textContent', skillNotice);
      updateField('skillNotice', 'hidden', !skillNotice);
      updateField('checkedAtLabel', 'hidden', !update?.checkedAt);
      updateField('checkedAt', 'hidden', !update?.checkedAt);
      updateField('checkedAt', 'textContent', update?.checkedAt ? time(Date.parse(update.checkedAt)) : '');
      updateField('agentApplyUpdate', 'hidden', !update?.available);
      updateField('agentApplyUpdate', 'disabled', busy || data.maintenanceBusy || !health.skillHealthy);
      updateField('checkUpdates', 'disabled', busy || data.maintenanceBusy);
      updateField('restartNotice', 'hidden', !health.restartRequired);
    }
    if (data.enabled && !data.connected) updateField('agentStatus', 'textContent', copy.waiting);
    else if ($('agentStatus').textContent === copy.waiting) $('agentStatus').textContent = '';
    const signature = JSON.stringify(data.approvals);
    if (signature === previous) return;
    previous = signature;
    $('agentEmpty').hidden = data.approvals.length > 0;
    $('requests').replaceChildren();
    for (const entry of [...data.approvals].reverse()) {
      const section = document.createElement('article'); section.className = 'agent-request'; section.dataset.request = entry.id;
      text(section, 'h3', copy[entry.operation]);
      const status = text(section, 'p', copy[entry.status] ?? entry.status);
      if (entry.status === 'pending') {
        status.className = 'agent-motion-badge agent-awaiting';
        status.insertAdjacentHTML('afterbegin', agentApprovalIcon);
      }
      text(section, 'p', `${copy.request}: ${entry.requestId} · ${copy.client}: ${entry.clientId}`, 'agent-meta');
      for (const rule of entry.summary.rules ?? []) {
        const block = document.createElement('div'); block.className = 'agent-rule';
        text(block, 'strong', rule.domain);
        text(block, 'p', `${rule.includeSubdomains ? copy.subdomains : copy.exact} · ${rule.days === null ? copy.all : `${copy.days}: ${rule.days}`}`);
        const schedule = rule.schedule;
        text(block, 'p', `${copy.schedule}: ${schedule ? `${copy[schedule.type]} ${schedule.type === 'once' ? time(schedule.at) : schedule.time}${schedule.type === 'weekly' ? ` · ${copy.weekday}: ${schedule.weekday}` : ''}${schedule.type === 'monthly' ? ` · ${copy.monthDay}: ${schedule.day}` : ''}` : copy.legacy}`);
        section.append(block);
      }
      if (entry.summary.enabled !== undefined) text(section, 'p', entry.summary.enabled ? copy.enabled : copy.disabled);
      if (entry.summary.paused !== undefined) text(section, 'p', entry.summary.paused ? copy.paused : copy.resumed);
      if (entry.summary.matches !== undefined) text(section, 'p', `${copy.matches}: ${entry.summary.matches} · ${copy.protected}: ${entry.summary.protected}`);
      if (entry.operation === 'execute') text(section, 'p', copy.allVisits, 'agent-warning');
      if (entry.summary.enabled || entry.summary.paused === false) text(section, 'p', copy.future, 'agent-warning');
      if (entry.error) text(section, 'p', `${copy.error} (${entry.error})`, 'agent-warning');
      if (entry.status === 'pending') {
        text(section, 'p', `${copy.expires}: ${time(entry.expiresAt)}`, 'agent-meta');
        const actions = document.createElement('div'); actions.className = 'agent-actions';
        for (const approved of [true, false]) {
          const button = text(actions, 'button', approved ? copy.approve : copy.reject, approved ? 'primary' : 'quiet');
          button.type = 'button'; button.disabled = busy;
          button.addEventListener('click', () => { void act('agent-decide', { id: entry.id, approved }); });
        }
        section.append(actions);
      }
      $('requests').append(section);
    }
    focusRequest();
  }
  function focusRequest() {
    if (!standalone) return;
    const id = new URLSearchParams(location.hash.slice(1)).get('request');
    if (!id || id === focusedRequest) return;
    const request = [...root.querySelectorAll('[data-request]')].find(node => node.dataset.request === id);
    if (!request) return;
    request.tabIndex = -1;
    request.scrollIntoView({ block: 'start' }); request.focus({ preventScroll: true });
    focusedRequest = id;
  }
  async function request(type, fields = {}) {
    const message = { type, ...fields };
    const response = await send(message);
    if (!response?.ok) throw new Error(response?.code ?? 'AGENT_UNAVAILABLE');
    return response.data;
  }
  async function refresh() {
    if (busy || refreshing || document.hidden || root.closest('[hidden], dialog:not([open])')) return;
    refreshing = true;
    const generation = actionGeneration;
    // A request can settle after its Agent tab has been removed or remounted.
    const isCurrent = () => !signal.aborted && !busy && generation === actionGeneration;
    try {
      const data = await request('agent-state');
      if (isCurrent()) render(data);
    } catch {
      if (isCurrent()) updateField('agentStatus', 'textContent', copy.error);
    }
    finally { refreshing = false; }
  }
  async function act(type, fields) {
    const key = type + (fields?.id ?? '');
    if (busy || Date.now() - (lastActions.get(key) ?? 0) < 800) return;
    actionGeneration++;
    busy = true; lastActions.set(key, Date.now());
    let checkFailed = false;
    checkingUpdates = type === 'agent-check-updates';
    if (checkingUpdates) {
      checkedCurrent = false;
      renderUpdateStatus(lastData?.companion);
    }
    $('automaticUpdates').disabled = true;
    root.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      if (type === 'agent-connect' && !await chrome.permissions.request({ permissions: ['nativeMessaging'] })) {
        if (!signal.aborted) $('agentStatus').textContent = copy.permission;
        return;
      }
      const data = await request(type, fields);
      if (signal.aborted) return;
      if (checkingUpdates) {
        const update = data.companion?.update;
        checkedCurrent = update?.available === false && !update.error;
      }
      $('agentStatus').textContent = '';
      previous = undefined;
      render(data);
    } catch (error) {
      checkFailed = checkingUpdates;
      if (!signal.aborted) $('agentStatus').textContent = `${copy.error} (${error instanceof Error ? error.message : 'AGENT_UNAVAILABLE'})`;
    } finally {
      busy = false;
      checkingUpdates = false;
      if (!signal.aborted) {
        root.querySelectorAll('button').forEach(button => { button.disabled = false; });
        $('automaticUpdates').disabled = false;
        if (lastData) render(lastData);
        if (checkFailed) updateField('updateState', 'textContent', copy.updateFailed);
      }
    }
  }
  watchAgentWork(chrome, working => {
    $('mcpWork').hidden = !working;
    $('mcpWork').toggleAttribute('data-agent-working', working);
  }, signal);
  $('connect').addEventListener('click', () => { void act('agent-connect'); });
  $('disconnect').addEventListener('click', () => { void act('agent-disconnect'); });
  $('automaticUpdates').addEventListener('change', () => { void act('agent-monitor', { enabled: $('automaticUpdates').checked }); });
  $('checkUpdates').addEventListener('click', () => { void act('agent-check-updates'); });
  $('agentApplyUpdate').addEventListener('click', () => { void act('agent-apply-update'); });
  function updateInstallerFields() {
    const mac = installerChoices.namedItem('platform').value === 'macos';
    $('installerClient').hidden = mac;
    $('installerVerification').hidden = mac;
    $('installerNote').textContent = mac ? copy.macInstallerNote : copy.installerNote;
    if (mac && chrome.runtime.id !== macInstallerDefaultExtensionId) {
      $('installerNote').append(` ${copy.macInstallerExtensionId} `);
      text($('installerNote'), 'code', chrome.runtime.id);
    }
    $('installerDownloadError').hidden = true;
  }
  $('installerPlatform').addEventListener('change', updateInstallerFields);
  updateInstallerFields();
  $('downloadInstaller').addEventListener('click', () => {
    $('installerDownloadError').hidden = true;
    const platform = installerChoices.namedItem('platform').value;
    try {
      const link = document.createElement('a');
      if (platform === 'macos') {
        link.href = macInstallerUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.click();
        return;
      }
      const client = installerChoices.namedItem('client').value;
      const installer = createInstallerDownload({ platform, client, extensionId: chrome.runtime.id, bootstrapSha256: agentRelease.bootstrapSha256 });
      const archive = new Blob([installer.bytes], { type: installer.mimeType });
      const href = URL.createObjectURL(archive);
      link.href = href;
      link.download = installer.filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(href), 10000);
    } catch {
      $('installerDownloadError').textContent = copy.installerDownloadError;
      $('installerDownloadError').hidden = false;
    }
  });
  if (standalone) window.addEventListener('hashchange', focusRequest, { signal });
  document.addEventListener('visibilitychange', refresh, { signal });
  const timer = setInterval(refresh, 2000);
  const dispose = () => { lifecycle.abort(); clearInterval(timer); };
  if (standalone) window.addEventListener('pagehide', dispose, { once: true, signal });
  void refresh();
  return dispose;
}

const standalonePage = document.querySelector('body > main.agent-page');
if (standalonePage) {
  const lang = readLanguage();
  document.documentElement.lang = lang;
  document.title = `${agentCopy(lang).title} — History Sweep`;
  mountAgentPage(standalonePage, { lang, standalone: true });
}
