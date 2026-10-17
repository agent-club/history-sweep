import { mkdir, readFile, copyFile, readdir, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dependency } from './runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sharp=dependency('sharp');
const manifest=JSON.parse(await readFile(root+'extension/manifest.json','utf8'));
if(JSON.stringify(manifest.permissions)!=='["history","activeTab","scripting","contextMenus","storage","favicon"]') throw new Error('Unexpected permissions');
for(const [file,w,h,allowAlpha=false] of [['icon-128.png',128,128,true],['promo-small-440x280.png',440,280],['promo-marquee-1400x560.png',1400,560],['screenshot-workspace-en-1280x800.png',1280,800],['screenshot-workspace-zh-1280x800.png',1280,800],['screenshot-popup-1280x800.png',1280,800]]){
 const meta=await sharp(root+'store/assets/'+file).metadata();
 if(meta.width!==w||meta.height!==h) throw new Error('Invalid dimensions: '+file);
 if(!allowAlpha&&meta.hasAlpha) throw new Error('Store image must not contain an alpha channel: '+file);
}
await mkdir(root+'dist',{recursive:true});await mkdir(root+'site/downloads',{recursive:true});
const extensionZip=root+'dist/history-sweep-'+manifest.version+'.zip';
const entries=['manifest.json','background.mjs','launcher.mjs','modal-host.mjs','modal.html','modal.mjs','popup.html','manager.html','app.css','app.mjs','view.mjs','theme.js','i18n.mjs','history-utils.mjs','history-filters.mjs','calendar-dates.mjs','date-picker.mjs','history-groups.mjs','history-suggestions.mjs','search-text.mjs','suggestions-ui.mjs','suggestions-worker.mjs','activity-calendar.mjs','activity-log.mjs','activity-panel.mjs','row-removal.mjs','batch-removal.mjs','vendor','locales','_locales','icons'];
const temporary=await mkdtemp(join(tmpdir(),'history-sweep-build-'));
try {
 const staged=join(temporary,'extension'); await mkdir(staged);
 for(const entry of entries) await cp(root+'extension/'+entry,join(staged,entry),{recursive:true});
 // Configuration sync remains unscheduled. Keep its development source intact, but
 // exclude its UI, files and network permissions from this specific release.
 if(manifest.version!=='0.4.0') throw new Error('Confirm the release scope before packaging a new version');
 const releaseManifest=structuredClone(manifest);
 delete releaseManifest.options_ui; delete releaseManifest.optional_host_permissions;
 releaseManifest.content_security_policy.extension_pages="script-src 'self'; object-src 'none'; connect-src 'none'";
 await writeFile(join(staged,'manifest.json'),JSON.stringify(releaseManifest,null,2)+'\n');
 const viewPath=join(staged,'view.mjs'); const view=await readFile(viewPath,'utf8');
 const syncEntry='<p><a href="sync.html" target="_blank" rel="noopener">${t(\'syncSettings\')}</a></p>';
 // A clean release checkout has no sync entry; the local development tree may have one.
 if(view.split(syncEntry).length>2) throw new Error('Unexpected duplicate configuration-sync entries');
 await writeFile(viewPath,view.replace(syncEntry,''));
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
 console.log('Validated store images and packaged v'+manifest.version+'; configuration sync excluded.');
} finally { await rm(temporary,{recursive:true,force:true}); }
