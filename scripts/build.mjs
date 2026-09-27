import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { dependency } from './runtime.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const sharp=dependency('sharp');
const manifest=JSON.parse(await readFile(root+'extension/manifest.json','utf8'));
if(JSON.stringify(manifest.permissions)!=='["history"]') throw new Error('Unexpected permissions');
for(const [file,w,h,allowAlpha=false] of [['icon-128.png',128,128,true],['promo-small-440x280.png',440,280],['promo-marquee-1400x560.png',1400,560],['screenshot-workspace-en-1280x800.png',1280,800],['screenshot-workspace-zh-1280x800.png',1280,800],['screenshot-popup-1280x800.png',1280,800]]){
 const meta=await sharp(root+'store/assets/'+file).metadata();
 if(meta.width!==w||meta.height!==h) throw new Error('Invalid dimensions: '+file);
 if(!allowAlpha&&meta.hasAlpha) throw new Error('Store image must not contain an alpha channel: '+file);
}
await mkdir(root+'dist',{recursive:true});await mkdir(root+'site/downloads',{recursive:true});
const extensionZip=root+'dist/history-sweep-'+manifest.version+'.zip';
const entries=['manifest.json','background.mjs','popup.html','manager.html','app.css','app.mjs','view.mjs','i18n.mjs','history-utils.mjs','locales','_locales','icons'];
execFileSync('zip',['-q','-r','-FS',extensionZip,...entries],{cwd:root+'extension'});
execFileSync('unzip',['-t',extensionZip]);
await copyFile(extensionZip,root+'site/downloads/history-sweep-'+manifest.version+'.zip');
execFileSync('zip',['-q','-r','-FS',root+'dist/history-sweep-site-'+manifest.version+'.zip','index.html','privacy.html','style.css','site.mjs','assets','downloads'],{cwd:root+'site'});
console.log('Validated store image dimensions and packaged extension + static website, version '+manifest.version);
