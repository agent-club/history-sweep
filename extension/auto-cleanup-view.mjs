// One task surface is shared by the full page and the existing settings container.
export function autoCleanupView(prefix = '') {
  const markup = `<section id="tasksPage" data-auto-id="tasksPage" class="auto-page">
 <div class="auto-scroll">
  <header class="auto-section-heading"><div><h1 data-copy="title" tabindex="-1"></h1><p data-copy="rulesIntro"></p></div><button id="newRule" data-auto-id="newRule" type="button" class="primary"></button></header>
  <section class="auto-status-line" aria-labelledby="statusHeading"><span id="statusDot" data-auto-id="statusDot" class="auto-status-dot" aria-hidden="true"></span><strong id="statusHeading" data-auto-id="statusHeading"></strong><p id="statusDetail" data-auto-id="statusDetail" class="sr-only" role="status"></p><span id="nextRun" data-auto-id="nextRun"></span><button id="pauseAll" data-auto-id="pauseAll" type="button" class="quiet"></button></section>
  <div class="auto-list-heading"><h2 data-copy="rulesHeading"></h2><span id="taskCount" data-auto-id="taskCount"></span></div>
  <div id="rulesList" data-auto-id="rulesList" class="auto-rules-list" aria-live="polite"></div>
  <div id="emptyRules" data-auto-id="emptyRules" class="auto-empty" hidden><div class="auto-empty-symbol" aria-hidden="true">◷</div><h2 data-copy="emptyTitle"></h2><p data-copy="emptyRules"></p><button id="createFirst" data-auto-id="createFirst" type="button" class="primary" data-copy="createFirst"></button></div>
  <button id="manageProtection" data-auto-id="manageProtection" class="auto-protection-link quiet" type="button" data-copy="manageProtection"></button>
  <section id="latestResult" data-auto-id="latestResult" class="auto-result" aria-live="polite" hidden><h2 id="latestResultTitle" data-auto-id="latestResultTitle"></h2><p id="latestResultDetail" data-auto-id="latestResultDetail"></p></section>
 </div>
 <footer class="auto-footer"><p data-copy="previewFirst"></p><button id="reviewAll" data-auto-id="reviewAll" class="auto-secondary" type="button"></button></footer>
</section>
<section id="ruleEditor" data-auto-id="ruleEditor" class="auto-page" aria-labelledby="editorHeading" hidden>
 <div class="auto-scroll"><button id="cancelEditor" data-auto-id="cancelEditor" type="button" class="auto-breadcrumb quiet"></button><h1 id="editorHeading" data-auto-id="editorHeading" tabindex="-1"></h1>
 <div class="auto-steps"><span class="is-current" data-copy="stepConditions"></span><i></i><span data-copy="stepPreview"></span><i></i><span data-copy="stepEnable"></span></div>
 <p id="handoffNotice" data-auto-id="handoffNotice" class="auto-notice" data-copy="handoffNotice" hidden></p>
 <form id="ruleForm" data-auto-id="ruleForm" novalidate>              <div class="auto-editor-fields">
                <label class="auto-field" for="ruleDomain"><span data-copy="domainLabel"></span><input id="ruleDomain" data-auto-id="ruleDomain" name="domain" type="text" inputmode="url" autocomplete="url" spellcheck="false" required></label>
                <label class="auto-field auto-select-field" for="ruleDaysPreset"><span data-copy="retentionLabel"></span>
                  <select id="ruleDaysPreset" data-auto-id="ruleDaysPreset" name="daysPreset"><option value="all"></option><option value="1"></option><option value="7" selected></option><option value="30"></option><option value="custom"></option></select>
                </label>
                <label class="auto-field auto-select-field auto-schedule-type" for="scheduleType"><span data-copy="scheduleLabel"></span>
                  <select id="scheduleType" data-auto-id="scheduleType" name="scheduleType"><option value="once"></option><option value="daily" selected></option><option value="weekly"></option><option value="monthly"></option><option value="legacy" hidden></option></select>
                </label>
                <label class="auto-field auto-select-field auto-schedule-at" id="scheduleAtField" data-auto-id="scheduleAtField" for="scheduleAt" hidden><span data-copy="onceAtLabel"></span><input id="scheduleAt" data-auto-id="scheduleAt" name="scheduleAt" type="datetime-local"></label>
                <div class="auto-field auto-schedule-time" id="scheduleTimeField" data-auto-id="scheduleTimeField"><label id="scheduleTimeLabel" for="scheduleTime" data-copy="scheduleTimeLabel"></label><div class="auto-time-control"><input id="scheduleTime" data-auto-id="scheduleTime" name="scheduleTime" type="text" value="02:00" readonly role="combobox" aria-haspopup="dialog" aria-expanded="false" autocomplete="off"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="12" cy="12" r="8.25"></circle><path d="M12 7.5V12l3 2"></path></svg></div></div>
                <label class="auto-field auto-select-field auto-schedule-weekday" id="scheduleWeekdayField" data-auto-id="scheduleWeekdayField" for="scheduleWeekday" hidden><span data-copy="weekdayLabel"></span>
                  <select id="scheduleWeekday" data-auto-id="scheduleWeekday" name="scheduleWeekday"></select>
                </label>
                <label class="auto-field auto-select-field auto-schedule-monthday" id="scheduleMonthDayField" data-auto-id="scheduleMonthDayField" for="scheduleMonthDay" hidden><span data-copy="monthdayLabel"></span>
                  <select id="scheduleMonthDay" data-auto-id="scheduleMonthDay" name="scheduleMonthDay"></select>
                </label>
                <fieldset class="auto-scope-fieldset">
                  <legend data-copy="scopeLabel"></legend>
                  <label class="auto-radio"><input type="radio" name="scope" value="exact" checked><span data-copy="scopeExact"></span></label>
                  <label class="auto-radio"><input type="radio" name="scope" value="subdomains"><span data-copy="scopeSubdomains"></span></label>
                </fieldset>
                <label id="customDaysField" data-auto-id="customDaysField" class="auto-field" for="ruleDays" hidden><span data-copy="customDaysLabel"></span><input id="ruleDays" data-auto-id="ruleDays" name="days" type="number" min="1" step="1" inputmode="numeric"></label>
              </div>
              <p id="ruleSummary" data-auto-id="ruleSummary" class="auto-rule-summary"></p>
              <p id="ruleError" data-auto-id="ruleError" class="auto-inline-error" role="alert" hidden></p>
              <p class="auto-editor-help" data-copy="scheduleHelp"></p>
              <p class="auto-editor-help" data-copy="previewFirst"></p>
</form></div>
 <footer class="auto-footer"><p data-copy="saveDoesNotDelete"></p><div class="auto-footer-actions"><button id="saveDisabled" data-auto-id="saveDisabled" type="button" class="quiet"></button><button id="previewRule" data-auto-id="previewRule" type="button" class="primary"></button></div></footer>
</section>
<section id="previewPanel" data-auto-id="previewPanel" class="auto-page" aria-labelledby="previewHeading" hidden>
 <div class="auto-scroll"><h1 id="previewHeading" data-auto-id="previewHeading" tabindex="-1"></h1><div class="auto-steps"><span data-copy="stepConditions"></span><i></i><span class="is-current" data-copy="stepPreview"></span><i></i><span data-copy="stepEnable"></span></div><p id="previewSummary" data-auto-id="previewSummary" class="auto-preview-summary" role="status"></p><p id="previewIntro" data-auto-id="previewIntro"></p>            <p id="previewScope" data-auto-id="previewScope"></p>
            <p id="previewSchedule" data-auto-id="previewSchedule" class="auto-rule-summary"></p>
            <p class="auto-rule-summary" data-copy="previewWarning"></p>
            <p id="protectedSummary" data-auto-id="protectedSummary" class="auto-protected-summary" hidden></p>
            <p id="fullyProtected" data-auto-id="fullyProtected" class="auto-inline-error" hidden></p>
            <div id="previewItems" data-auto-id="previewItems" class="auto-preview-items"></div>
            <p id="previewError" data-auto-id="previewError" class="auto-inline-error" role="alert" hidden></p>
</div>
 <footer class="auto-footer"><p data-copy="saveDoesNotDelete" id="previewSaveNote" data-auto-id="previewSaveNote"></p><div class="auto-footer-actions"><button id="closePreview" data-auto-id="closePreview" type="button" class="quiet"></button><button id="saveEnabled" data-auto-id="saveEnabled" type="button" class="primary" disabled></button><button id="deletePreviewNow" data-auto-id="deletePreviewNow" type="button" class="auto-danger" hidden></button></div></footer>
</section>
<section id="protectionPage" data-auto-id="protectionPage" class="auto-page" aria-labelledby="protectionHeading" hidden><div class="auto-scroll"><h1 id="protectionHeading" data-auto-id="protectionHeading" data-copy="protectionHeading" tabindex="-1"></h1><p class="auto-description" data-copy="protectionIntro"></p><form id="protectionForm" data-auto-id="protectionForm"><label class="auto-field" for="protectedDomains"><span data-copy="protectionLabel"></span><textarea id="protectedDomains" data-auto-id="protectedDomains" rows="6" spellcheck="false" disabled></textarea></label><p id="protectionError" data-auto-id="protectionError" class="auto-inline-error" role="alert" hidden></p></form></div><footer class="auto-footer"><p data-copy="local"></p><button id="saveProtection" data-auto-id="saveProtection" form="protectionForm" type="submit" class="primary" disabled></button></footer></section>
<p id="pageStatus" data-auto-id="pageStatus" class="auto-page-status" role="status" aria-live="polite"></p>
  <dialog id="confirmDialog" data-auto-id="confirmDialog" class="auto-confirm-dialog" aria-labelledby="confirmTitle" aria-describedby="confirmBody">
    <h2 id="confirmTitle" data-auto-id="confirmTitle"></h2><p id="confirmBody" data-auto-id="confirmBody"></p>
    <p id="confirmCounts" data-auto-id="confirmCounts" class="auto-confirm-counts" hidden></p>
    <p id="confirmError" data-auto-id="confirmError" class="auto-inline-error" role="alert" hidden></p>
    <div class="auto-dialog-actions"><button id="confirmCancel" data-auto-id="confirmCancel" type="button" class="quiet" autofocus></button><button id="confirmAccept" data-auto-id="confirmAccept" type="button" class="primary"></button></div>
  </dialog>
`;
  if (!prefix) return markup;
  return markup.replace(/(?<![\w-])id="([^"]+)"/g, (match, id) => match.startsWith('id=') ? `id="${prefix}${id}"` : match)
    .replace(/\b(for|aria-labelledby|aria-describedby|form)="([^"]+)"/g, (_, attr, value) => `${attr}="${value.split(' ').map(id => prefix + id).join(' ')}"`);
}
