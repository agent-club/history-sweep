import { agentRobotIcon, agentScanIcon } from './agent-motion.mjs';

const platformIcon = (shape) => `<svg class="agent-choice-icon" viewBox="0 0 24 24" aria-hidden="true">${shape}</svg>`;
const platforms = [
  ['macos', 'macOS', platformIcon('<path fill="currentColor" d="M12.9 5.7c.9-1 1.4-2.2 1.3-3.7-1.3.1-2.7.9-3.5 1.9-.7.9-1.3 2.1-1.1 3.4 1.4.1 2.6-.7 3.3-1.6ZM18 14.4c.1-2 1.6-3 2-3.3-1-1.5-2.5-2.3-4.1-2.3-1.6 0-2.3.8-3.8.8-1.4 0-2.3-.8-3.7-.8C5.8 8.9 4 11.1 4 14c0 2.2 1 4.8 2.3 6.4.6.8 1.4 1.6 2.4 1.6 1.2 0 1.8-.7 3.4-.7s2.1.7 3.4.7c1 0 1.7-.8 2.4-1.7.8-1 1.3-2 1.8-3.2-1-.4-1.8-1.5-1.7-2.7Z"/>')],
  ['windows', 'Windows', platformIcon('<path fill="currentColor" d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/>')],
  ['linux', 'Linux', platformIcon('<g fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9.5V7a4 4 0 0 1 8 0v2.5c0 2 2.5 3.6 2.5 7.5 0 2.5-2.9 3.5-6.5 3.5S5.5 19.5 5.5 17C5.5 13 8 11.5 8 9.5Z"/><path d="m10.3 9.2 1.7 1.1 1.7-1.1M7 17l-2.2 1.5M17 17l2.2 1.5M10.3 7.4h.1m3.2 0h.1"/></g>')],
];
const clients = [
  ['codex', 'Codex', '<img class="agent-choice-icon" src="icons/codex.png" alt="" width="18" height="18">'],
  ['claude-code', 'Claude Code', '<img class="agent-choice-icon" src="icons/claude-code.png" alt="" width="18" height="18">'],
];
const choices = (name, options, selected) => options.map(([value, label, icon]) => `
  <label class="agent-choice">
    <input class="agent-choice-input sr-only" type="radio" name="${name}" value="${value}"${value === selected ? ' checked' : ''}>
    <span class="agent-choice-face">${icon}<span class="agent-choice-label">${label}</span><img class="agent-choice-check" src="icons/ui/check.svg" alt="" width="12" height="12"></span>
  </label>`).join('');

export const agentMarkup = `
  <a class="agent-back" href="auto-cleanup.html" data-copy="back"></a>
  <header class="agent-heading">
    <div class="agent-heading-row"><h1 tabindex="-1" data-copy="title"></h1><span id="connectionState" class="agent-badge" role="status"></span></div>
    <p data-copy="intro"></p>
  </header>
  <div class="agent-setup">
    <section class="agent-setup-step" aria-labelledby="installHeading">
      <span class="agent-step-index" aria-hidden="true">01</span>
      <div class="agent-step-content">
        <h2 id="installHeading" class="agent-step-title" data-copy="installTitle"></h2>
        <form id="installerChoices">
          <fieldset id="installerPlatform" class="agent-choice-group">
            <legend class="agent-choice-legend" data-copy="platformLabel"></legend>
            <div class="agent-choices agent-platform-choices">${choices('platform', platforms)}</div>
          </fieldset>
          <fieldset id="installerClient" class="agent-choice-group" hidden>
            <legend class="agent-choice-legend" data-copy="clientLabel"></legend>
            <div class="agent-choices">${choices('client', clients, 'codex')}</div>
          </fieldset>
        </form>
        <div class="settings-action-row agent-install-row">
          <div class="settings-action-main">
            <p id="installerNote" class="agent-meta"></p>
            <p id="installerVerification" class="agent-meta" data-copy="installerVerification" hidden></p>
          </div>
          <button id="downloadInstaller" class="primary settings-action-controls" type="button" data-copy="downloadInstaller"></button>
        </div>
        <p id="installerDownloadError" class="agent-warning" role="status" hidden></p>
      </div>
    </section>
    <section class="agent-setup-step" aria-labelledby="connectionHeading">
      <span class="agent-step-index" aria-hidden="true">02</span>
      <div class="agent-step-content">
        <h2 id="connectionHeading" class="agent-step-title" data-copy="connectTitle"></h2>
        <div class="settings-action-row agent-connect-row">
          <div class="settings-action-main">
            <p class="agent-meta" data-copy="disclosure"></p>
            <p id="agentStatus" role="status"></p>
          </div>
          <div class="settings-action-controls agent-actions"><button id="connect" class="secondary-action" data-copy="connect" type="button"></button><button id="disconnect" class="quiet" data-copy="disconnect" type="button" hidden></button></div>
        </div>
        <div id="profile" hidden><label for="profileId" data-copy="profile"></label><input id="profileId" readonly spellcheck="false"></div>
        <label class="agent-monitor"><input id="automaticUpdates" type="checkbox" checked><span data-copy="automaticUpdates"></span></label><p class="agent-meta" data-copy="monitorDisclosure"></p>
      </div>
    </section>
  </div>
  <section id="companionHealth" class="agent-connection agent-updates" aria-labelledby="healthHeading" hidden>
    <div class="settings-action-row agent-update-row">
      <div class="settings-action-main">
        <h2 id="healthHeading" class="agent-update-heading" data-copy="healthTitle"></h2>
        <p id="updateState" class="agent-update-summary" role="status"></p>
        <p id="restartNotice" class="agent-update-notice" data-copy="restartNotice" hidden></p>
        <p id="skillNotice" class="agent-update-notice" hidden></p>
      </div>
      <div class="settings-action-controls agent-actions">
        <button id="checkUpdates" class="quiet" type="button">${agentScanIcon}<span data-copy="checkUpdates"></span></button>
        <button id="agentApplyUpdate" class="primary" type="button" data-copy="applyUpdate" hidden></button>
      </div>
    </div>
    <div role="status"><span id="mcpWork" class="agent-motion-badge" hidden>${agentRobotIcon}<span data-copy="requestInProgress"></span></span></div>
    <details class="agent-update-details">
      <summary class="agent-update-details-toggle" data-copy="technicalDetails"></summary>
      <dl class="agent-update-facts">
        <dt data-copy="installedVersion"></dt><dd id="installedVersion"></dd>
        <dt data-copy="runningVersion"></dt><dd id="runningVersion"></dd>
        <dt data-copy="mcpLastSeen"></dt><dd id="mcpLastRequest"></dd>
        <dt data-copy="skillLabel"></dt><dd id="skillHealth"></dd>
        <dt id="checkedAtLabel" data-copy="checkedAt" hidden></dt><dd id="checkedAt" hidden></dd>
      </dl>
    </details>
  </section>
  <section class="agent-launch" aria-labelledby="agentLaunchHeading">
    <h2 id="agentLaunchHeading" class="agent-launch-title" data-copy="launchTitle"></h2>
    <p class="agent-meta agent-launch-hint" data-copy="launchHint"></p>
    <figure class="agent-example">
      <figcaption class="agent-example-label" data-copy="launchExample"></figcaption>
      <blockquote class="agent-example-prompt" data-copy="launchPrompt"></blockquote>
    </figure>
    <div class="agent-launch-actions">
      <a id="openCodex" class="secondary-action" rel="noreferrer">
        <img class="agent-launch-icon" src="icons/codex.png" alt="" width="18" height="18">
        <span data-copy="openCodex"></span>
      </a>
      <a id="openClaudeCode" class="secondary-action" rel="noreferrer">
        <img class="agent-launch-icon" src="icons/claude-code.png" alt="" width="18" height="18">
        <span data-copy="openClaudeCode"></span>
      </a>
    </div>
  </section>
  <section aria-labelledby="requestsHeading"><h2 id="requestsHeading" data-copy="approvals"></h2><p id="agentEmpty" class="agent-empty" data-copy="empty"></p><div id="requests"></div></section>
`;
