import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { enterWorkspace } from './native-workspace.mjs';

const { chromium } = dependency('playwright');
const profile = await mkdtemp(join(tmpdir(), 'history-sweep-tabs-'));
const extension = fileURLToPath(new URL('../extension/', import.meta.url));
const screenshots = process.env.HISTORY_SWEEP_SCREENSHOTS;
const errors = [];
let context, page, checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const tab = id => page.locator(`[data-settings-tab="${id}"]`);
const select = id => tab(id).locator('[role=tab]').click();
const close = id => tab(id).locator('.settings-tab-close').click();
const section = name => page.locator(`[data-settings-section="${name}"]`).click();
const active = id => page.waitForFunction(id => document.querySelector(`[data-settings-tab="${id}"] [role=tab]`)?.getAttribute('aria-selected') === 'true', id);
const capture = async name => {
  if(!screenshots) return;
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.locator('#preferencesDialog').screenshot({path:join(screenshots, `${name}.png`),animations:'disabled'});
};

try {
  if(screenshots) await mkdir(screenshots, {recursive:true});
  context = await chromium.launchPersistentContext(profile, {
    executablePath:process.env.HISTORY_SWEEP_CHROMIUM,
    channel:process.env.HISTORY_SWEEP_CHROMIUM ? undefined : 'chromium',headless:true,
    viewport:{width:1440,height:900},reducedMotion:'reduce',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
  });
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin=`chrome-extension://${new URL(worker.url()).hostname}`;
  page=await context.newPage();page.setDefaultTimeout(8000);
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{localStorage.setItem('language','zh-CN');localStorage.setItem('theme','light');});
  await page.goto(`${origin}/manager.html`);await enterWorkspace(page);
  await page.locator('#openPreferences').click();
  await page.waitForFunction(()=>!document.querySelector('#savePreferences').disabled);
  await active('general');
  check(await page.locator('.settings-tabs-more').isHidden(),'ellipsis is hidden when all tabs fit');
  const geometry=await tab('general').evaluate(node=>({height:node.getBoundingClientRect().height,radius:getComputedStyle(node).borderRadius}));
  check(geometry.height===28 && geometry.radius==='6px','page tabs use the agreed compact height and small corners');

  const settingsNav = page.locator('#preferencesDialog .settings-nav');
  const agentSection = settingsNav.getByRole('button', { name: 'Agent 访问', exact: true });
  await agentSection.press('Enter');
  await active('agent');
  check(await agentSection.getAttribute('aria-current') === 'page' &&
    await page.locator('#settings-panel-agent').getByRole('heading', { name: 'Agent 访问', exact: true }).isVisible(),
    'the Agent sidebar item opens and selects the existing Agent page');
  await agentSection.click();
  check(await tab('agent').count() === 1, 'reopening Agent from the sidebar uses the same page tab');
  await capture('sidebar-agent');
  await close('agent');
  await active('general');
  const sidebarToggle = settingsNav.getByRole('button', { name: '收起设置侧栏' });
  const settingsPages = page.locator('#preferencesDialog .settings-pages');
  const expandedNav = await settingsNav.boundingBox();
  const expandedPages = await settingsPages.boundingBox();
  const expandedToggle = await sidebarToggle.boundingBox();
  await capture('sidebar-expanded');
  await sidebarToggle.click();
  const expandSidebar = settingsNav.getByRole('button', { name: '展开设置侧栏' });
  const collapsedToggle = await expandSidebar.boundingBox();
  check((await settingsNav.boundingBox()).width === 64 && (await settingsPages.boundingBox()).width === expandedPages.width + 156,
    'desktop collapse reduces the 220px sidebar to 64px and gives the space to the page');
  check(expandedNav.width === 220 && collapsedToggle.x === expandedToggle.x && collapsedToggle.y === expandedToggle.y,
    'the sidebar toggle stays in place when the rail collapses');
  check(await settingsNav.locator('[data-settings-section] .ui-icon:visible').count() === 8 &&
    await settingsNav.locator('.settings-nav-label:visible, .settings-brand:visible, .settings-nav-title:visible').count() === 0,
    'the collapsed rail shows all eight icons and hides labels and branding');
  await capture('sidebar-collapsed');
  const privacy = settingsNav.getByRole('button', { name: '隐私', exact: true });
  await privacy.click();
  await active('privacy');
  check(await privacy.getAttribute('aria-current') === 'page', 'icon-only navigation selects and highlights the requested page');
  await expandSidebar.press('Enter');
  check(await sidebarToggle.getAttribute('aria-expanded') === 'true' && await privacy.getAttribute('aria-current') === 'page',
    'keyboard expansion keeps the current settings page selected');
  await close('privacy');
  await active('general');

  await section('recommendations');await active('recommendation-list');
  await page.locator('#recommendation-editHabit').click();await active('recommendation-habit');
  await page.locator('#recommendation-lookback').fill('21');
  await section('privacy');await select('recommendation-habit');
  check(await page.locator('#recommendation-lookback').inputValue()==='21','recommendation editor draft survives switching pages');
  await close('recommendation-habit');
  await page.locator('#recommendation-confirm').waitFor({state:'visible'});
  await page.locator('#recommendation-keep').click();
  check(await tab('recommendation-habit').isVisible(),'cancelled close keeps the page tab');
  await close('recommendation-habit');await page.locator('#recommendation-discard').click();
  await active('recommendation-list');
  check(await tab('recommendation-habit').count()===0,'confirmed close removes the recommendation editor');
  await page.locator('#recommendation-editHabit').click();
  await page.locator('#recommendation-lookback').fill('28');await section('privacy');
  await close('recommendation-habit');await page.locator('#recommendation-confirm').waitFor({state:'visible'});
  await page.locator('#recommendation-discard').click();await active('privacy');
  check(await tab('recommendation-habit').count()===0,'background recommendation pages can confirm closing without replacing the active page');

  await section('tasks');
  await page.waitForFunction(()=>!document.querySelector('#cleanup-newRule').disabled);
  await page.locator('#cleanup-newRule:visible, #cleanup-createFirst:visible').first().click();await active('cleanup-ruleEditor');
  await page.locator('#cleanup-ruleDomain').fill('tabs-fixture.example.test');
  await select('cleanup-tasksPage');await select('cleanup-ruleEditor');
  check(await page.locator('#cleanup-ruleDomain').inputValue()==='tabs-fixture.example.test','task draft survives switching to its parent tab');
  await page.locator('#cleanup-previewRule').click();await active('cleanup-previewPanel');
  await page.waitForFunction(()=>!document.querySelector('#cleanup-saveEnabled').disabled);
  await close('cleanup-previewPanel');await active('cleanup-ruleEditor');
  check(await page.locator('#cleanup-ruleDomain').inputValue()==='tabs-fixture.example.test','closing a preview returns to the intact task editor');
  check(await page.locator('#cleanup-cancelEditor').isHidden(),'redundant content back button is replaced by tabs');
  await capture('desktop-task-editor');
  const before=await tab('cleanup-ruleEditor').boundingBox();
  await page.locator('#cleanup-ruleEditor .auto-scroll').evaluate(node=>node.scrollTop=node.scrollHeight);
  const after=await tab('cleanup-ruleEditor').boundingBox();
  check(before.y===after.y,'page tabs remain pinned while form content scrolls');
  await close('cleanup-ruleEditor');await page.locator('#cleanup-confirmDialog').waitFor({state:'visible'});
  await page.locator('#cleanup-confirmCancel').click();
  check(await page.locator('#cleanup-ruleDomain').inputValue()==='tabs-fixture.example.test','keeping a dirty task retains its draft');
  await close('cleanup-ruleEditor');await page.locator('#cleanup-confirmAccept').click();await active('cleanup-tasksPage');
  check(await tab('cleanup-ruleEditor').count()===0,'discard closes the task editor and selects the adjacent page');
  check((await page.evaluate(async()=>await chrome.runtime.sendMessage({type:'auto-get'}))).data.config.rules.length===0,'closing an editor does not save or schedule a task');

  await section('privacy');await page.locator('#privateCleanup').check();
  await close('privacy');await page.locator('#unsavedPreferencesDialog').waitFor({state:'visible'});
  await page.locator('#keepEditingPreferences').click();
  check(await page.locator('#privateCleanup').isChecked(),'cancelled privacy-tab close keeps unsaved settings');
  await close('privacy');await page.locator('#discardPreferences').click();
  await page.waitForFunction(()=>!document.querySelector('[data-settings-tab=privacy]'));
  check(await page.locator('#preferencesDialog').evaluate(node=>node.open),'closing one preference tab keeps the settings window open');
  await section('privacy');
  check(!await page.locator('#privateCleanup').isChecked(),'discarded privacy values restore the baseline');
  await section('general');
  await page.locator('#defaultRange').evaluate(node=>{node.value='30days';node.dispatchEvent(new Event('change',{bubbles:true}));});
  await close('general');await page.locator('#unsavedPreferencesDialog').waitFor({state:'visible'});
  await page.locator('#saveUnsavedPreferences').click();
  await page.waitForFunction(()=>!document.querySelector('[data-settings-tab=general]'));
  check(await page.locator('#preferencesDialog').evaluate(node=>node.open),'save and close applies to the chosen tab');
  check((await page.evaluate(async()=>await chrome.storage.local.get('browsingPreferences'))).browsingPreferences.range==='30days','save on tab close persists the edited preferences');

  for(const name of ['general','protection','sync','recommendations']) await section(name);
  await active('recommendation-list');
  await page.setViewportSize({width:440,height:700});
  const expandedNarrow = await settingsNav.boundingBox();
  await sidebarToggle.click();
  check((await settingsNav.boundingBox()).height < expandedNarrow.height &&
    await settingsNav.locator('[data-settings-section] .ui-icon:visible').count() === 8 &&
    await settingsNav.evaluate(node => node.scrollWidth === node.clientWidth),
    'narrow collapse reduces navigation to a single row of icons that fits');
  await capture('sidebar-narrow-collapsed');
  await agentSection.press('Enter');
  await active('agent');
  check(await agentSection.getAttribute('aria-current') === 'page', 'the narrow icon rail can open Agent access with the keyboard');
  await capture('sidebar-agent-narrow');
  await close('agent');
  await select('recommendation-list');
  await active('recommendation-list');
  await expandSidebar.click();
  await page.locator('.settings-tabs-more').waitFor({state:'visible'});
  const strip=page.locator('.settings-tabs-list');
  check(await strip.evaluate(node=>node.scrollWidth>node.clientWidth),'visited tabs overflow horizontally in a narrow window');
  await page.locator('.settings-tabs-more').click();
  check(await page.locator('.settings-tabs-menu-page').count()===await page.locator('.settings-tab').count(),'ellipsis lists all visited pages');
  const bounds=await page.locator('.settings-tabs-menu').boundingBox();
  check(bounds.x>=0 && bounds.x+bounds.width<=440,'overflow menu stays inside the narrow window');
  await capture('narrow-overflow-menu');
  await page.keyboard.press('Escape');
  check(await page.locator('.settings-tabs-menu').isHidden() && await page.locator('#preferencesDialog').evaluate(node=>node.open),'Escape dismisses the overflow menu without closing settings');
  await page.locator('.settings-tabs-more').click();
  await page.locator('.settings-tabs-menu-page').filter({hasText:'清理任务'}).click();await active('cleanup-tasksPage');
  const visibility=await tab('cleanup-tasksPage').evaluate(node=>{const view=node.parentElement.getBoundingClientRect(),r=node.getBoundingClientRect();return r.left>=view.left-1 && r.right<=view.right+1;});
  check(visibility,'selecting a hidden page reveals its tab in the strip');
  await tab('cleanup-tasksPage').locator('[role=tab]').press('Home');
  await active('recommendation-list');
  await page.waitForFunction(()=>document.querySelector('.settings-tabs-list').scrollLeft<1);
  const viewport=await strip.boundingBox();
  await page.mouse.move(viewport.x+viewport.width/2,viewport.y+viewport.height/2);
  await page.mouse.wheel(180,0);
  await page.waitForFunction(()=>document.querySelector('.settings-tabs-list').scrollLeft>10);
  check(true,'native horizontal wheel moves the visited-page strip');
  await tab('recommendation-list').locator('[role=tab]').focus();await page.keyboard.press('Home');
  await page.waitForFunction(()=>document.querySelector('.settings-tabs-list').scrollLeft<1);
  await page.mouse.wheel(0,180);
  await page.waitForFunction(()=>document.querySelector('.settings-tabs-list').scrollLeft>10);
  check(true,'vertical mouse wheel also supports horizontal tab navigation');
  await page.locator('.settings-tabs-more').click();
  await page.locator('.settings-tabs-menu-page').first().click();
  await page.waitForFunction(()=>document.querySelector('.settings-tabs-list').scrollLeft<1);
  const touch=await context.newCDPSession(page);
  await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
  const y=viewport.y+viewport.height/2,start=viewport.x+viewport.width-15;
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start,y}]});
  for(const delta of [30,70,120,170]) await touch.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start-delta,y}]});
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForFunction(()=>document.querySelector('.settings-tabs-list').scrollLeft>10);
  check(true,'touch swiping horizontally moves the tab strip');await touch.detach();
  await capture('narrow-scrolled-tabs');
  await strip.evaluate(node => { node.scrollLeft = 20; });
  await page.waitForFunction(() => {
    const strip = document.querySelector('.settings-tabs-list');
    const first = strip.firstElementChild;
    const viewport = strip.getBoundingClientRect();
    const bounds = first.getBoundingClientRect();
    return bounds.left < viewport.left && bounds.right > viewport.left && getComputedStyle(first).opacity === '0';
  });
  check(true,'a partially clipped tab does not show a fragment of its label');
  await page.setViewportSize({width:1440,height:900});
  await page.locator('.settings-tabs-more').waitFor({state:'hidden'});
  check(true,'ellipsis disappears again when the pages fit');
  await page.evaluate(()=>document.dispatchEvent(new CustomEvent('history-sweep:set-theme',{detail:'dark'})));
  await section('tasks');await page.locator('#cleanup-newRule:visible, #cleanup-createFirst:visible').first().click();
  await capture('dark-task-editor');
  const darkTabs=await page.locator('#settingsTabs').evaluate(root=>{
    const strip=root.querySelector('.settings-tabs-list'),bounds=strip.getBoundingClientRect();
    return {more:!root.querySelector('.settings-tabs-more').hidden,width:strip.clientWidth,content:strip.scrollWidth,left:strip.scrollLeft,
      clipped:[...strip.children].some(node=>{const r=node.getBoundingClientRect();return r.left<bounds.left-1 || r.right>bounds.right+1;})};
  });
  check(darkTabs.more || !darkTabs.clipped,`desktop overflow always has an ellipsis entry: ${JSON.stringify(darkTabs)}`);
  await close('cleanup-ruleEditor');await active('sync');
  await section('tasks');await page.locator('#cleanup-newRule:visible, #cleanup-createFirst:visible').first().click();
  await page.locator('#cleanup-ruleDomain').fill('suspended-draft.example.test');
  await section('general');
  await page.locator('#savePreferences').click();
  await page.locator('#cleanup-confirmDialog').waitFor({state:'visible'});
  await page.locator('#cleanup-confirmCancel').click();
  check(await page.locator('#preferencesDialog').evaluate(node=>node.open),'saving preferences cannot silently discard a suspended task draft');
  await select('cleanup-ruleEditor');
  check(await page.locator('#cleanup-ruleDomain').inputValue()==='suspended-draft.example.test','suspended task draft remains intact after keeping it');
  await page.locator('#dismissPreferences').click();
  await page.locator('#cleanup-confirmAccept').click();
  await page.waitForFunction(()=>!document.querySelector('#preferencesDialog').open);
  check(true,'discard confirmation can finish closing the settings window');
  await page.locator('#openPreferences').click();await active('general');
  for(const id of await page.locator('.settings-tab').evaluateAll(nodes=>nodes.map(node=>node.dataset.settingsTab))) {
    await close(id);
    await page.waitForFunction(id=>!document.querySelector(`[data-settings-tab="${id}"]`),id);
  }
  await page.waitForFunction(()=>!document.querySelector('#preferencesDialog').open);
  check(true,'closing the final tab returns to browsing history');
  await page.locator('#openPreferences').click();await active('general');
  check(await page.locator('.settings-tab').count()===1,'settings can be reopened after all page tabs close');
  check(errors.length===0,`no browser runtime errors: ${errors.join('; ')}`);
  console.log(`${checks} native settings-tab checks passed. Disposable profile and synthetic settings only.`);
} catch(error) {
  if(screenshots && page && !page.isClosed()) await page.screenshot({path:join(screenshots,'failure.png')}).catch(()=>{});
  console.error('Settings-tab checks failed:',error.message,errors);
  throw error;
} finally { await context?.close();await rm(profile,{recursive:true,force:true}); }
