import { mkdir, readFile, copyFile, readdir, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dependency } from './runtime.mjs';
import { generateReleaseNotes } from './generate-release-notes.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sharp=dependency('sharp');
const manifest=JSON.parse(await readFile(root+'extension/manifest.json','utf8'));
if(JSON.stringify(manifest.permissions)!=='["history","activeTab","scripting","contextMenus","storage","favicon","alarms"]') throw new Error('Unexpected permissions');
for(const [file,w,h,allowAlpha=false] of [['icon-128.png',128,128,true],['promo-small-440x280.png',440,280],['promo-marquee-1400x560.png',1400,560],['screenshot-workspace-en-1280x800.png',1280,800],['screenshot-workspace-zh-1280x800.png',1280,800],['screenshot-popup-1280x800.png',1280,800]]){
 const meta=await sharp(root+'store/assets/'+file).metadata();
 if(meta.width!==w||meta.height!==h) throw new Error('Invalid dimensions: '+file);
 if(!allowAlpha&&meta.hasAlpha) throw new Error('Store image must not contain an alpha channel: '+file);
}
await generateReleaseNotes();
await mkdir(root+'dist',{recursive:true});await mkdir(root+'site/downloads',{recursive:true});
const extensionZip=root+'dist/history-sweep-'+manifest.version+'.zip';
const entries=['manifest.json','background.mjs','update-check.mjs','launcher.mjs','modal-host.mjs','modal.html','modal.mjs','popup.html','manager.html','app.css','app.mjs','view.mjs','release-notes.mjs','nameplate.mjs','nameplate-reveal.mjs','nameplate-store.mjs','nameplate.css','settings-select.mjs','theme.js','startup.js','i18n.mjs','history-utils.mjs','history-filters.mjs','history-frequency.mjs','browsing-preferences.mjs','calendar-dates.mjs','date-picker.mjs','history-groups.mjs','history-suggestions.mjs','search-text.mjs','suggestions-ui.mjs','suggestions-worker.mjs','activity-calendar.mjs','activity-log.mjs','activity-panel.mjs','activity-reveal.mjs','row-removal.mjs','batch-removal.mjs','sync.html','sync.css','sync-page.mjs','config-sync.mjs','config-store.mjs','vendor','locales','_locales','icons'];
entries.push('auto-cleanup-view.mjs','auto-cleanup.html','auto-cleanup-page.mjs','auto-cleanup.css','auto-cleanup-copy.mjs','auto-cleanup.mjs','auto-cleanup-model.mjs','auto-cleanup-schedule.mjs','time-picker.mjs');
const temporary=await mkdtemp(join(tmpdir(),'history-sweep-build-'));
try {
 const staged=join(temporary,'extension'); await mkdir(staged);
 for(const entry of entries) await cp(root+'extension/'+entry,join(staged,entry),{recursive:true});
 // v0.6.0 includes local cleanup tasks, nameplates and the shared release notes.
 // Preserve the source entry point, optional host permissions and HTTPS CSP.
 if(manifest.version!=='0.6.0') throw new Error('Confirm the release scope before packaging a new version');
 // Start fresh so a previously built archive cannot retain deferred or obsolete files.
 const candidate=join(temporary,'extension.zip');
 execFileSync('zip',['-q','-r',candidate,...entries,'-x','*/.DS_Store'],{cwd:staged});
 execFileSync('unzip',['-t',candidate]);
 await copyFile(candidate,extensionZip);
 await copyFile(candidate,root+'site/downloads/history-sweep-'+manifest.version+'.zip');
 // Collect the complete site tree, including new homepage modules and stylesheets.
 const siteEntries=(await readdir(root+'site')).filter(name=>!name.startsWith('.')).sort();
 const website=join(temporary,'site.zip');
 execFileSync('zip',['-q','-r',website,...siteEntries,'-x','*/.DS_Store'],{cwd:root+'site'});
 execFileSync('unzip',['-t',website]);
 await copyFile(website,root+'dist/history-sweep-site-'+manifest.version+'.zip');
 console.log('Validated store images and packaged v'+manifest.version+' with cleanup tasks and offline release notes.');
} finally { await rm(temporary,{recursive:true,force:true}); }
