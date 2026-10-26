import { readLanguage } from './i18n.mjs';
import { autoCleanupView } from './auto-cleanup-view.mjs';
import { translateAutoCleanup as t } from './auto-cleanup-copy.mjs';
import { normalizeRule, rulesOverlap } from './auto-cleanup-model.mjs';
import { normalizeSchedule, nextOccurrence } from './auto-cleanup-schedule.mjs';
import { setupTimePicker } from './time-picker.mjs';

export function mountAutoCleanup(root, { lang = readLanguage(), send = message => chrome.runtime.sendMessage(message), onSection = () => {} } = {}) {
root.classList.add('auto-cleanup-root');
root.innerHTML = autoCleanupView(root.dataset.embedded === 'true' ? 'cleanup-' : '');
const $ = id => root.querySelector(`[data-auto-id="${id}"]`);
let currentPage = 'tasksPage';
let previewReturn = 'tasksPage';
function showPage(id) {
  timePicker.close();
  currentPage = id;
  for (const page of root.querySelectorAll('.auto-page')) page.hidden = page.dataset.autoId !== id;
  $(id).querySelector('h1')?.focus({ preventScroll: true });
}
function navigate(section, rule) {
  guardUnsaved(() => {
    dirty = false; clearPreview(); $('ruleEditor').hidden = true;
    onSection(section);
    if (section === 'tasks' || section === 'protection') showPage(section === 'tasks' ? 'tasksPage' : 'protectionPage');
    if (rule) { openEditor({ ...rule, days:7, schedule:{type:'daily',time:'02:00'} }); $('handoffNotice').hidden=false; }
  });
}
const tr = (key, values) => t(lang, key, values);
const timePicker = setupTimePicker($('scheduleTime'), { root, label: tr('scheduleTimeLabel'), hourLabel: tr('timeHour'), minuteLabel: tr('timeMinute'), doneLabel: tr('timeDone') });
let state = null;
let editingId = null;
let preview = null;
let previewKey = '';
let allPreview = null;
let draftGeneration = 0;
let previewRequest = 0;
let refreshRequest = 0;
let busy = false;
let dirty = false;
let confirmAction = null;
let timer = 0;
let protectionOriginal = null;
let protectionReady = false;
let disposed = false;


root.querySelectorAll('[data-copy]').forEach((node) => { node.textContent = tr(node.dataset.copy); });
root.querySelectorAll('[data-copy-label]').forEach((node) => { node.setAttribute('aria-label', tr(node.dataset.copyLabel)); });

const labels = { pauseAll: 'pause', reviewAll: 'reviewAll', newRule: 'addRule', editorHeading: 'editorNew', previewHeading: 'previewHeading', closePreview: 'closePreview', previewRule: 'previewRule', saveDisabled: 'saveDisabled', saveEnabled: 'saveEnabled', cancelEditor: 'cancel', emptyRules: 'emptyRules', confirmCancel: 'confirmCancel', saveProtection: 'saveProtection', deletePreviewNow: 'deleteNow' };
Object.entries(labels).forEach(([id, key]) => { if(id !== 'emptyRules') $(id).textContent = tr(key); });
const select = $('ruleDaysPreset');
[ ['all','allPages'], ['1','day1'], ['7','day7'], ['30','day30'], ['custom','custom'] ].forEach(([value,key]) => { select.querySelector(`[value="${value}"]`).textContent = tr(key); });
const scheduleSelect = $('scheduleType');
[['once','scheduleOnce'],['daily','scheduleDaily'],['weekly','scheduleWeekly'],['monthly','scheduleMonthly'],['legacy','scheduleLegacy']].forEach(([value,key])=>{scheduleSelect.querySelector(`[value="${value}"]`).textContent=tr(key);});
for(let day=1;day<=31;day++) $('scheduleMonthDay').add(new Option(String(day),String(day)));
for(let day=0;day<=6;day++) $('scheduleWeekday').add(new Option(tr(`weekday${day}`),String(day)));
$('ruleDomain').placeholder = tr('domainPlaceholder');
$('ruleDays').placeholder = tr('customDaysPlaceholder');
$('protectedDomains').placeholder = tr('protectionPlaceholder');
$('statusHeading').textContent = tr('loading');
$('statusDetail').textContent = tr('loading');
$('createFirst').disabled = true; $('reviewAll').hidden=true; $('pauseAll').disabled = true; $('reviewAll').disabled = true; $('newRule').disabled = true;

async function request(type, fields = {}) {
  let response;
  try { response = await send({ type, ...fields }); }
  catch { throw Object.assign(new Error(tr('pageError')), { code: 'AUTO_UNAVAILABLE' }); }
  if (!response?.ok) { const key=`error_${response?.code}`; throw Object.assign(new Error(key===tr(key)?tr('confirmError'):tr(key)), { code: response?.code }); }
  return response.data;
}
function setStatus(message) { $('pageStatus').textContent = message || ''; }
function setBusy(value) {
  busy=value;
  for(const id of ['confirmCancel','confirmAccept','deletePreviewNow']) $(id).disabled=value;
  updateRuleActions();
  $('saveEnabled').disabled=value || !preview || preview.fullyProtected;
  if(state) {
    $('pauseAll').disabled=value; $('newRule').disabled=value;
    $('reviewAll').disabled=value || state.running || state.config.paused || !state.config.rules.some(rule=>rule.enabled);
  }
  $('rulesList').querySelectorAll('button').forEach(button=>{button.disabled=value;});
}
function fmtTime(value) { const date=new Date(value); return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(lang === 'zh-CN' ? 'zh-CN' : 'en', { dateStyle: 'medium', timeStyle: 'short' }).format(date) : tr('scheduleMissingTime'); }
function localDateTime(value) {
  const date=new Date(value); if(!Number.isFinite(date.getTime())) return '';
  const pad=n=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function scheduleValue() {
  const type=scheduleSelect.value;
  if(type==='legacy') return null;
  if(type==='once') {
    const input=$('scheduleAt').value;
    const at=input ? new Date(input).getTime() : NaN;
    return {type,at};
  }
  const result={type,time:$('scheduleTime').value};
  if(type==='weekly') result.weekday=Number($('scheduleWeekday').value);
  if(type==='monthly') result.day=Number($('scheduleMonthDay').value);
  return result;
}
function ruleValue() {
  const days = select.value === 'all' ? null : select.value === 'custom' ? Number($('ruleDays').value) : Number(select.value);
  const rule={ domain: $('ruleDomain').value.trim(), includeSubdomains: $('ruleForm').elements.scope.value === 'subdomains', days };
  const schedule=scheduleValue(); if(schedule) rule.schedule=schedule;
  return rule;
}
function ruleValidationError(rule) {
  try { normalizeRule(rule); return ''; }
  catch(error) { return error.message; }
}
function updateRuleActions() {
  const disabled=busy || Boolean(ruleValidationError(ruleValue()));
  $('previewRule').disabled=disabled;
  $('saveDisabled').disabled=disabled;
}
function signature(rule, id=editingId) {
  const schedule=rule.schedule;
  return JSON.stringify([rule.domain,rule.includeSubdomains,rule.days,
    schedule?[schedule.type,schedule.at,schedule.time,schedule.weekday,schedule.day]:null,id]);
}
function clearPreview() {
  draftGeneration++; previewRequest++; preview = null; previewKey = ''; allPreview = null;
  $('saveEnabled').disabled = true; $('deletePreviewNow').hidden = true; $('previewPanel').hidden=true;
}
function protectionDirty() { return protectionReady && $('protectedDomains').value !== protectionOriginal; }
function hasUnsavedChanges() { return dirty || protectionDirty(); }
function guardUnsaved(action) {
  if(busy) return;
  if(!hasUnsavedChanges()) { action(); return; }
  ask(tr('confirmDiscardTitle'),tr('confirmDiscardBody'),tr('confirmDiscard'),async()=>{
    dirty=false; $('ruleEditor').hidden=true; editingId=null; clearPreview();
    if(protectionDirty()) { $('protectedDomains').value=protectionOriginal; }
    action();
  });
}
function openEditor(rule = null, id = null) {
  editingId = id; dirty = false; clearPreview(); remove.hidden=!id; $('handoffNotice').hidden=true;
  showPage('ruleEditor'); $('editorHeading').textContent = tr(id ? 'editorEdit' : 'editorNew');
  $('ruleDomain').value = rule?.domain || ''; $('ruleDaysPreset').value = rule?.days===null?'all':[1,7,30].includes(rule?.days) ? String(rule.days) : rule ? 'custom' : '7';
  $('ruleDays').value = rule?.days && ![1,7,30].includes(rule.days) ? rule.days : '';
  $('ruleForm').elements.scope.value = rule?.includeSubdomains ? 'subdomains' : 'exact';
  const schedule=rule?.schedule||null;
  scheduleSelect.value=schedule?.type|| (rule?'legacy':'daily');
  $('scheduleType').querySelector('[value="legacy"]').hidden=!rule||Boolean(schedule);
  $('scheduleAt').value=schedule?.type==='once'?localDateTime(schedule.at):'';
  $('scheduleTime').value=schedule?.time||'02:00';
  $('scheduleWeekday').value=String(schedule?.type==='weekly'?schedule.weekday:1);
  $('scheduleMonthDay').value=String(schedule?.type==='monthly'?schedule.day:1);
  updateScheduleFields();
  $('customDaysField').hidden = select.value !== 'custom'; $('ruleError').hidden = true;
  updateRuleSummary(); $('ruleDomain').focus();
}
function updateScheduleFields() {
  timePicker.close();
  const type=scheduleSelect.value;
  $('scheduleAtField').hidden=type!=='once'; $('scheduleTimeField').hidden=type==='once'||type==='legacy';
  $('scheduleWeekdayField').hidden=type!=='weekly'; $('scheduleMonthDayField').hidden=type!=='monthly';
}
function updateRuleSummary() { const r = ruleValue(); $('ruleSummary').textContent = r.domain ? tr('taskSummary', { domain:r.domain, days:r.days===null?tr('allPagesSummary'):tr('daysPlain',{n:r.days}), schedule:scheduleLabel(r.schedule) }) : ''; updateRuleActions(); }
function scheduleLabel(schedule) {
  if(!schedule) return tr('scheduleLegacySummary');
  if(schedule.type==='once') return tr('scheduleOnceAt',{time:Number.isFinite(schedule.at)?fmtTime(schedule.at):tr('scheduleMissingTime')});
  if(schedule.type==='daily') return tr('scheduleDailyAt',{time:schedule.time||tr('scheduleMissingTime')});
  if(schedule.type==='weekly') return tr('scheduleWeeklyAt',{day:tr(`weekday${schedule.weekday}`),time:schedule.time||tr('scheduleMissingTime')});
  if(schedule.type==='monthly') return tr('scheduleMonthlyAt',{day:schedule.day,time:schedule.time||tr('scheduleMissingTime')});
  return tr('scheduleLegacySummary');
}
function appendText(parent, tag, text, cls) { const node = document.createElement(tag); if (cls) node.className = cls; node.textContent = text; parent.append(node); return node; }
function button(label, action, cls='quiet') { const b = document.createElement('button'); b.type='button'; b.className=cls; b.textContent=label; b.addEventListener('click', action); return b; }

function renderRules() {
  const list = $('rulesList'); list.replaceChildren();
  const rules = state?.config?.rules || [];
  $('emptyRules').hidden = rules.length > 0;
  $('taskCount').textContent = rules.length;
  $('newRule').hidden = rules.length === 0;
  $('reviewAll').hidden = !rules.some(rule=>rule.enabled);
  $('pauseAll').hidden = rules.length === 0;
  root.querySelector('.auto-list-heading').hidden = rules.length === 0;
  for (const rule of rules) {
    const card = document.createElement('article'); card.className='auto-rule-card';
    const head = document.createElement('div'); head.className='auto-rule-head';
    const mark = appendText(head,'span',rule.domain[0].toUpperCase(),'auto-site-mark'); mark.setAttribute('aria-hidden','true');
    const info = document.createElement('div'); info.className='auto-rule-info';
    appendText(info,'h3',rule.domain); appendText(info,'p',tr(rule.includeSubdomains?'includeSubdomains':'domainOnly'));
    appendText(info,'p',rule.days===null?tr('allPagesSummary'):tr('days',{n:rule.days}));
    appendText(info,'p',scheduleLabel(rule.schedule));
    if(rule.nextRunAt) appendText(info,'p',tr('taskNextRun',{time:fmtTime(rule.nextRunAt)}));
    const badgeKey=rule.completed?'completed':rule.enabled?'enabled':'disabled';
    const badge=appendText(head,'span',tr(badgeKey),'auto-rule-badge'); badge.hidden=rule.enabled&&!rule.completed;
    head.insertBefore(info, head.lastElementChild); card.append(head);
    const actions = document.createElement('div'); actions.className='auto-rule-actions';
    actions.append(button(tr('edit'),()=>guardUnsaved(()=>openEditor(rule,rule.id))));
    const toggle = button(tr(rule.enabled?'disable':'enable'),()=>rule.enabled ? guardUnsaved(()=>toggleRule(rule,false)) : guardUnsaved(()=>{openEditor(rule,rule.id);void runPreview(rule,rule.id);}), 'auto-switch');
    toggle.setAttribute('role','switch'); toggle.setAttribute('aria-checked',String(rule.enabled)); toggle.setAttribute('aria-label',`${tr(rule.enabled?'disable':'enable')} · ${rule.domain}`);
    actions.append(toggle);
    card.append(actions); list.append(card);
  }
}
function render() {
  if (!state) return;
  const enabled = state.config.rules.some(r=>r.enabled);
  $('statusHeading').textContent = tr(state.config.paused?'statusPaused':enabled?'statusOn':'statusEmpty');
  $('statusDot').classList.toggle('is-paused',state.config.paused || !enabled);
  $('statusDetail').textContent = state.running ? (state.stopping?tr('stopping'):tr('busy')) : tr(state.config.paused?'runPaused':enabled?'runEnabled':'runNone');
  $('pauseAll').textContent = tr(state.config.paused?'resume':'pause');
  $('pauseAll').disabled = false;
  $('reviewAll').disabled = Boolean(state.running || state.config.paused || !enabled);
  $('nextRun').textContent = state.config.nextRunAt ? tr('nextRun',{time:fmtTime(state.config.nextRunAt)}) : tr('nextRunNone');
  $('latestResult').hidden = !state.result || state.softPrivacy || state.privateCleanup;
  if (state.result && !state.softPrivacy) {
    const result=state.result;
    $('latestResultTitle').textContent = tr(result.phase==='done'?'runDone':result.phase==='partial'?'runPartial':result.phase==='verifyFailed'?'runVerifyFailed':result.phase==='interrupted'?'runInterrupted':result.phase==='stopped'?'runStopped':'runFailed');
    $('latestResultDetail').textContent = result.phase==='done'&&result.removed===0?tr('noEligible'):result.phase==='done'?tr('runDoneDetail',{removed:result.removed,skipped:result.skipped}):result.phase==='partial'?tr('runPartialDetail',{removed:result.removed,remaining:result.remaining}):result.phase==='verifyFailed'||result.phase==='failed'?tr(`error_${state.error||'AUTO_ACTIVITY_FAILED'}`):'';
    if(result.phase==='verifyFailed') $('latestResultDetail').textContent=tr('runUncertainDetail',{removed:result.removed,uncertain:result.uncertain});
    if(result.incomplete) $('latestResultDetail').textContent += ` ${tr('recoveryIncomplete')}`;
  }
  if(state.error) setStatus(tr(`error_${state.error}`)); else setStatus('');
  $('pauseAll').disabled=busy;
  $('reviewAll').disabled=busy || Boolean(state.running || state.config.paused || !enabled);
  $('newRule').disabled=busy; $('createFirst').disabled=busy;
  renderRules();
  $('rulesList').querySelectorAll('button').forEach(button=>{button.disabled=busy;});
}
function renderPreviewGroups(data) {
  const root=$('previewItems'); root.replaceChildren();
  const groups=new Map();
  for(const item of data.items) {
    let host;
    try { host=new URL(item.url).hostname; } catch { continue; }
    if(!host) continue;
    if(!groups.has(host)) groups.set(host,[]);
    groups.get(host).push(item);
  }
  const entries=[...groups]; let shownGroups=0;
  const appendItem=(list,item)=>{
    const row=document.createElement('article'); row.className='auto-preview-item';
    if(item.title) appendText(row,'strong',item.title);
    const link=document.createElement('a'); link.textContent=item.url; link.href=item.url; link.target='_blank'; link.rel='noopener noreferrer';
    if(!/^https?:\/\//i.test(item.url)) link.removeAttribute('href');
    row.append(link);
    const rule=data.rule || state?.config?.rules?.find(candidate=>candidate.id===item.ruleId);
    if(rule) appendText(row,'small',tr('matchReason',{domain:rule.domain,days:rule.days===null?tr('allPagesSummary'):tr('daysPlain',{n:rule.days})}));
    appendText(row,'small',tr('pageLastVisit',{time:fmtTime(item.lastVisitTime)})); list.append(row);
  };
  const appendGroups=(count)=>{
    const end=Math.min(entries.length,shownGroups+count);
    for(;shownGroups<end;shownGroups++) {
      const [host,items]=entries[shownGroups];
      const detail=document.createElement('details'); detail.className='auto-preview-host';
      const summary=document.createElement('summary'); summary.textContent=`${host} · ${items.length}`; detail.append(summary);
      const list=document.createElement('div'); list.className='auto-preview-group'; detail.append(list);
      let shown=0, more=null;
      detail.addEventListener('toggle',()=>{
        if(!detail.open || shown) return;
        const add=()=>{more?.remove();const stop=Math.min(items.length,shown+20);for(;shown<stop;shown++) appendItem(list,items[shown]);if(shown<items.length){more=button(tr('morePages'),add);list.append(more);}};
        add();
      });
      root.append(detail);
    }
    if(shownGroups<entries.length) root.append(button(tr('moreWebsites'),()=>{root.lastElementChild?.remove();appendGroups(20);},'quiet'));
  };
  appendGroups(20);
}
function preparePreview(all) {
  $('saveEnabled').hidden=all; $('deletePreviewNow').hidden=true;
  $('previewSaveNote').hidden=all; $('previewPanel').querySelector('.auto-steps').hidden=all;
  for(const id of ['previewIntro','previewScope','previewSchedule']) $(id).textContent='';
  $('protectedSummary').hidden=true; $('fullyProtected').hidden=true;
}
function previewFailure(error) {
  const node=$('previewError'); node.textContent=error.message;
  if(error.code==='AUTO_CONFLICT') {
    try {
      const conflict=state.config.rules.find(saved=>saved.id!==editingId && rulesOverlap(saved,ruleValue()));
      if(conflict) node.append(button(tr('editConflict',{domain:conflict.domain}),()=>guardUnsaved(()=>openEditor(conflict,conflict.id))));
    } catch {}
  }
  showPage('previewPanel'); node.hidden=false;
}
async function refresh() {
  const ticket=++refreshRequest;
  try {
    const data=await request('auto-get');
    if(disposed || ticket!==refreshRequest) return;
    if(state && state.config.revision!==data.config.revision) { clearPreview(); if(currentPage==='previewPanel') showPage(previewReturn); }
    state=data; render();
  } catch(e) { if(ticket===refreshRequest) setStatus(e.message); }
  finally { if(!disposed && ticket===refreshRequest) schedulePoll(); }
}
function schedulePoll() { clearTimeout(timer); if(state?.running) timer=setTimeout(refresh,1000); }
function showPreview(data, {all=false,rule=null,label=''}={}) {
  if (all) { allPreview=data; preview=null; previewKey=''; $('saveEnabled').disabled=true; }
  else { allPreview=null; preview=data; previewKey=signature(rule || ruleValue()); }
  showPage('previewPanel'); $('previewSummary').textContent=all?tr(data.items.length?'confirmReviewCount':'confirmNoMatches',{count:data.items.length,excluded:data.excluded}):tr(data.items.length?'previewItems':'previewNoItems',{count:data.items.length});
  $('deletePreviewNow').hidden=!all; $('deletePreviewNow').disabled=!data.items.length;
  $('saveEnabled').hidden=all; $('previewSaveNote').hidden=all;
  $('previewPanel').querySelector('.auto-steps').hidden=all;
  $('previewIntro').textContent=all?tr('confirmReviewBody'):'';
  $('previewScope').textContent=data.rule?tr(data.rule.includeSubdomains?'enableScopeSubdomains':'enableScopeExact',{domain:data.rule.domain}):'';
  const next=rule?.schedule?nextOccurrence(rule.schedule,Date.now()):null;
  $('previewSchedule').textContent=all?'':state?.config.paused?tr('runPaused'):rule?.schedule?(next===null?tr('scheduleNoNext'):tr('previewNextRun',{time:fmtTime(next)})):tr('previewNextRun',{time:fmtTime(state?.config.nextRunAt||Date.now()+86400000)});
  $('protectedSummary').hidden=!data.excluded; $('protectedSummary').textContent=data.excluded?tr('protectedExcluded',{count:data.excluded}):'';
  $('fullyProtected').hidden=!data.fullyProtected; $('fullyProtected').textContent=data.fullyProtected?tr('fullyProtected'):'';
  renderPreviewGroups(data);
  if (!all) $('saveEnabled').disabled=Boolean(data.fullyProtected || !data.previewId);
  $('previewHeading').textContent=label || tr('previewHeading');
}
async function runPreview(rule=ruleValue(),id=editingId) {
  const error=ruleValidationError(rule);
  if(error) { $('ruleError').textContent=tr(`error_${error}`); $('ruleError').hidden=false; return; }
  if(rule.schedule) {
    try { rule={...rule,schedule:normalizeSchedule(rule.schedule)}; }
    catch { $('ruleError').textContent=tr('error_AUTO_INVALID_SCHEDULE'); $('ruleError').hidden=false; return; }
  }
  previewReturn='ruleEditor'; clearPreview(); preparePreview(false);
  const generation=draftGeneration, ticket=previewRequest, requestedSignature=signature(rule,id);
  try { setStatus(''); $('previewError').hidden=true; $('previewItems').replaceChildren(); $('previewSummary').textContent=tr('previewLoading'); showPage('previewPanel');
    const data=await request('auto-preview',id?{rule,id}:{rule});
    if(disposed || ticket!==previewRequest || generation!==draftGeneration || requestedSignature!==signature(ruleValue(),editingId)) return;
    showPreview(data,{rule,label:tr('previewHeading')});
  } catch(e) { if(ticket!==previewRequest) return; clearPreview(); previewFailure(e); }
}
function ask(title,body,accept,callback,counts='') {
  $('confirmTitle').textContent=title; $('confirmBody').textContent=body;
  $('confirmCounts').textContent=counts; $('confirmCounts').hidden=!counts;
  $('confirmError').hidden=true; $('confirmAccept').textContent=accept;
  $('confirmAccept').className = title===tr('confirmDeleteNow') || title===tr('confirmRemoveTitle') ? 'auto-danger' : 'primary';
  confirmAction=callback; $('confirmDialog').showModal(); $('confirmCancel').focus();
}
$('confirmDialog').addEventListener('cancel',event=>{if(busy){event.preventDefault();return;}confirmAction=null;});
async function acceptDialog() {
  if(!confirmAction || busy) return;
  setBusy(true); $('confirmAccept').disabled=true;
  try { await confirmAction(); $('confirmDialog').close(); confirmAction=null; }
  catch(e) { $('confirmError').textContent=tr(`error_${e.code}`)||e.message||tr('confirmError'); $('confirmError').hidden=false; }
  finally { setBusy(false); $('confirmAccept').disabled=false; }
}
async function toggleRule(rule,enabled) {
  try { await request('auto-toggle',{id:rule.id,enabled,revision:state.config.revision}); await refresh(); }
  catch(e) { setStatus(tr(`error_${e.code}`)||e.message); }
}
async function saveRule(enabled) {
  if(busy) return;
  const rule=ruleValue();
  const error=ruleValidationError(rule);
  if(error) { $('ruleError').textContent=tr(`error_${error}`); $('ruleError').hidden=false; return; }
  if(rule.schedule) {
    try { rule.schedule=normalizeSchedule(rule.schedule); }
    catch { $('ruleError').textContent=tr('error_AUTO_INVALID_SCHEDULE'); $('ruleError').hidden=false; return; }
    if(enabled&&rule.schedule.type==='once'&&rule.schedule.at<=Date.now()) { $('ruleError').textContent=tr('error_AUTO_SCHEDULE_PAST'); $('ruleError').hidden=false; return; }
  }
  if(enabled && (!preview || previewKey!==signature(rule))) { await runPreview(rule,editingId); if(!preview) return; }
  const confirmedRule=enabled?preview.rule:rule;
  if(!confirmedRule) { clearPreview(); $('ruleError').textContent=tr('error_AUTO_PREVIEW_REQUIRED'); $('ruleError').hidden=false; return; }
  const proof=enabled?preview:null;
  const action=async()=>{
    const payload={rule:confirmedRule,id:editingId||undefined,enabled,revision:state.config.revision};
    if(enabled) payload.previewId=proof.previewId;
    await request('auto-save',payload);
    dirty=false; $('ruleEditor').hidden=true; clearPreview(); showPage('tasksPage'); await refresh();
  };
  if(enabled) { const scope=confirmedRule.includeSubdomains?tr('enableScopeSubdomains',{domain:confirmedRule.domain}):tr('enableScopeExact',{domain:confirmedRule.domain}); const days=confirmedRule.days===null?tr('allPagesSummary'):tr('daysPlain',{n:confirmedRule.days}); ask(tr('confirmEnableTitle'),tr('confirmEnableBody',{scope,days,schedule:scheduleLabel(confirmedRule.schedule)}),tr('confirmEnable'),action); }
  else { setBusy(true); try { await action(); } catch(e) { $('ruleError').textContent=e.message; $('ruleError').hidden=false; } finally { setBusy(false); } }
}
async function reviewAll() {
  previewReturn='tasksPage'; clearPreview(); preparePreview(true);
  const ticket=previewRequest;
  try {
    setStatus(''); $('previewError').hidden=true; $('previewItems').replaceChildren(); showPage('previewPanel'); $('previewSummary').textContent=tr('previewLoading');
    const generation=draftGeneration;
    const data=await request('auto-preview',{all:true});
    if(disposed || ticket!==previewRequest || generation!==draftGeneration) return;
    showPreview(data,{all:true,label:tr('confirmReviewTitle')});
  } catch(e) { if(ticket!==previewRequest) return; $('previewError').textContent=e.message; $('previewError').hidden=false; }
}
async function deleteReviewedPages() {
  if(!allPreview) return;
  const proof=allPreview;
  const counts=proof.items.length?tr('confirmReviewCount',{count:proof.items.length,excluded:proof.excluded}):tr('confirmNoMatches');
  ask(tr('confirmDeleteNow'),tr('confirmDeleteBody'),tr('confirmRun'),async()=>{await request('auto-run',{previewId:proof.previewId,revision:state.config.revision});allPreview=null;showPage('tasksPage');await refresh();},counts);
}
function cancelEditor() { guardUnsaved(()=>{dirty=false;editingId=null;clearPreview();showPage('tasksPage');}); }
$('ruleForm').querySelectorAll('input,select').forEach(el=>el.addEventListener('input',()=>{dirty=true;clearPreview();$('ruleError').hidden=true;updateRuleSummary();}));
select.addEventListener('change',()=>{$('customDaysField').hidden=select.value!=='custom';});
scheduleSelect.addEventListener('change',()=>{updateScheduleFields();dirty=true;clearPreview();$('ruleError').hidden=true;updateRuleSummary();});
$('createFirst').addEventListener('click',()=>openEditor());
$('manageProtection').addEventListener('click',()=>navigate('protection'));
$('newRule').addEventListener('click',()=>guardUnsaved(()=>openEditor())); $('cancelEditor').addEventListener('click',cancelEditor);
$('previewRule').addEventListener('click',()=>runPreview()); $('saveDisabled').addEventListener('click',()=>saveRule(false)); $('saveEnabled').addEventListener('click',()=>saveRule(true));
$('closePreview').addEventListener('click',()=>{showPage(previewReturn);}); $('reviewAll').addEventListener('click',reviewAll); $('deletePreviewNow').addEventListener('click',deleteReviewedPages);
$('confirmCancel').addEventListener('click',()=>{$('confirmDialog').close();confirmAction=null;}); $('confirmAccept').addEventListener('click',acceptDialog);
$('pauseAll').addEventListener('click',async()=>{try{await request('auto-pause',{paused:!state.config.paused,revision:state.config.revision});await refresh();}catch(e){setStatus(tr(`error_${e.code}`)||e.message);}});
async function loadProtection() {
  try { const data=await request('get-protection'); if(disposed)return; if(!Array.isArray(data.sites)) throw new Error(); protectionOriginal=data.sites.join('\n'); protectionReady=true; $('protectedDomains').value=protectionOriginal; $('protectedDomains').disabled=false; $('saveProtection').disabled=false; $('protectionError').hidden=true; }
  catch { protectionReady=false; $('protectedDomains').disabled=true; $('saveProtection').disabled=true; $('protectionError').textContent=tr('protectionUnavailable'); $('protectionError').hidden=false; }
}
$('protectionForm').addEventListener('submit',async e=>{e.preventDefault();$('protectionError').hidden=true;try{await request('save-protection',{input:$('protectedDomains').value});protectionOriginal=$('protectedDomains').value;protectionReady=true;clearPreview();setStatus(tr('protectionSaved'));}catch(err){$('protectionError').textContent=tr(`error_${err.code}`)||err.message;$('protectionError').hidden=false;}});
$('protectedDomains').addEventListener('input',()=>{if(!protectionReady)$('saveProtection').disabled=true;});
const beforeUnload=e=>{if(hasUnsavedChanges()){e.preventDefault();e.returnValue='';}};
window.addEventListener('beforeunload',beforeUnload);
const storageChanged=(changes,area)=>{
  if(area!=='local') return;
  if(Object.hasOwn(changes,'protectedSites')) { clearPreview(); if(currentPage==='previewPanel') showPage(previewReturn); if(!hasUnsavedChanges()) void loadProtection(); }
  if(['autoCleanup','autoCleanupRuntime','privateCleanup','softPrivacy'].some(key=>Object.hasOwn(changes,key))) void refresh();
};
chrome.storage?.onChanged?.addListener(storageChanged);
$('ruleForm').addEventListener('submit',event=>{event.preventDefault();void runPreview();});
const remove = document.createElement('button'); remove.type='button'; remove.className='auto-remove quiet'; remove.textContent=tr('remove');
remove.hidden=true; $('ruleForm').append(remove);
remove.addEventListener('click',()=>{const rule=state?.config.rules.find(rule=>rule.id===editingId);if(!rule)return;ask(tr('confirmRemoveTitle'),tr('confirmRemoveBody'),tr('confirmRemove'),async()=>{await request('auto-remove',{id:rule.id,revision:state.config.revision});dirty=false;editingId=null;clearPreview();showPage('tasksPage');await refresh();});});

function back() {
  if($('scheduleTime').getAttribute('aria-expanded')==='true') { timePicker.close(true); return true; }
  if(currentPage!=='ruleEditor' && currentPage!=='previewPanel') return false;
  if(currentPage==='previewPanel') showPage(previewReturn); else cancelEditor();
  return true;
}
if(root.dataset.embedded!=='true') root.addEventListener('keydown',event=>{if(event.key!=='Escape'||event.defaultPrevented||$('confirmDialog').open)return;const selectOpen=CSS.supports('selector(select:open)')&&root.querySelector('select:open');if(selectOpen)return;if(back()){event.preventDefault();event.stopPropagation();}});
loadProtection(); refresh();
return { navigate, guardUnsaved, hasUnsavedChanges, back, destroy:()=>{timePicker.destroy();disposed=true;refreshRequest++;clearPreview();clearTimeout(timer);window.removeEventListener('beforeunload',beforeUnload);chrome.storage?.onChanged?.removeListener(storageChanged);}, dismiss: () => { timePicker.close(); if($('confirmDialog').open) { if(!busy){$('confirmDialog').close();confirmAction=null;} return; } guardUnsaved(()=>{dirty=false;clearPreview();showPage('tasksPage');}); } };
}

if (document.body.classList.contains('auto-cleanup-page')) {
const lang=readLanguage(), tr=(key)=>t(lang,key);
const shell=document.getElementById('cleanupSettings');
shell.innerHTML=`<header class="settings-window-header"><a class="settings-back" href="manager.html">${tr('back')}</a><span>${tr('eyebrow')}</span></header><div class="settings-layout"><nav class="settings-nav"><a href="manager.html#settings=general">${tr('general')}</a><a href="manager.html#settings=privacy">${tr('privacy')}</a><button type="button" data-section="tasks">${tr('title')}</button><button type="button" data-section="protection">${tr('protectionHeading')}</button><div class="settings-brand">History Sweep<small>${tr('local')}</small></div></nav><div id="standaloneTasks"></div></div>`;
const cleanup=mountAutoCleanup(document.getElementById('standaloneTasks'),{onSection:section=>shell.querySelectorAll('[data-section]').forEach(button=>button.setAttribute('aria-current',button.dataset.section===section?'page':'false'))});
shell.querySelectorAll('[data-section]').forEach(button=>button.addEventListener('click',()=>cleanup.navigate(button.dataset.section)));
shell.querySelector('.settings-back').addEventListener('click',event=>{event.preventDefault();cleanup.guardUnsaved(()=>location.assign('manager.html'));});
const fragment=new URLSearchParams(location.hash.slice(1));
cleanup.navigate('tasks',fragment.get('domain')?{domain:fragment.get('domain'),includeSubdomains:fragment.get('subdomains')==='1'}:null);
}


