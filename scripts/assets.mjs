import { mkdir, readFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dependency } from './runtime.mjs';
import { createServer } from './serve.mjs';
import { installMock } from './fixtures.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const sharp = dependency('sharp');
const { chromium } = dependency('playwright');
for(const dir of ['site/assets','store/assets','extension/icons']) await mkdir(root + dir, {recursive:true});
const mark = await readFile(root + 'extension/icons/mark.svg');
await copyFile(root+'extension/icons/mark.svg', root+'site/assets/mark.svg');
for(const size of [16,32,48,128]) await sharp(mark).resize(size,size).png().toFile(root+'extension/icons/icon-'+size+'.png');
await copyFile(root+'extension/icons/icon-128.png',root+'store/assets/icon-128.png');
const server = createServer(); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const installedChrome='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath=process.env.HISTORY_SWEEP_CHROME || (existsSync(installedChrome) ? installedChrome : undefined);
const browser=await chromium.launch({headless:true, ...(executablePath ? {executablePath} : {})});
try{
 for(const lang of ['en','zh-CN']){
   const context=await browser.newContext({viewport:{width:1280,height:800},deviceScaleFactor:1});
   const page=await context.newPage(); await installMock(page);
   await page.addInitScript(lang=>localStorage.setItem('language',lang),lang);
   for(const layout of ['manager','popup']){
     await page.setViewportSize(layout==='popup'?{width:440,height:590}:{width:1280,height:800});
     await page.goto(origin+'/extension/'+layout+'.html');
     await page.locator('#query').fill('X'); await page.locator('#search').click();
     await page.waitForFunction(()=>document.querySelector('#count').textContent.startsWith('124'));
     await page.locator('#selectAll').click();
     await page.locator('input[type=checkbox]').nth(1).uncheck();
     await page.mouse.move(0, 0);
     const suffix=lang==='en'?'en':'zh';
     await page.screenshot({path:root+'site/assets/'+layout+'-'+suffix+'.png'});
     if(layout==='manager') {
       const screenshot=await page.screenshot();
       await sharp(screenshot).flatten({background:'#f7f5ef'}).removeAlpha().png().toFile(root+'store/assets/screenshot-workspace-'+suffix+'-1280x800.png');
     }
   }
   await context.close();
 }
 const popup=await readFile(root+'site/assets/popup-en.png');
 const svg=(width,height,body)=>Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="'+width+'" height="'+height+'"><rect width="100%" height="100%" fill="#f7f5ef"/>'+body+'</svg>');
 const embed='<image x="780" y="86" width="440" height="590" xlink:href="data:image/png;base64,'+popup.toString('base64')+'"/>';
 await sharp(svg(1280,800,'<circle cx="990" cy="395" r="290" fill="#e7e9df"/><text x="70" y="145" fill="#b95332" font-family="sans-serif" font-size="17" letter-spacing="3">HISTORY SWEEP</text><text x="70" y="265" fill="#292e26" font-family="Georgia" font-size="74">A little less</text><text x="70" y="350" fill="#b95332" font-family="Georgia" font-style="italic" font-size="74">history.</text><text x="74" y="430" fill="#73766b" font-family="sans-serif" font-size="22">Find. Select all. Clear in batches.</text><text x="74" y="474" fill="#73766b" font-family="sans-serif" font-size="19">Right from your toolbar.</text>'+embed+'<text x="74" y="730" fill="#73766b" font-family="sans-serif" font-size="13">Actual product interface · Illustrative browsing data</text>')).flatten({background:'#f7f5ef'}).removeAlpha().png().toFile(root+'store/assets/screenshot-popup-1280x800.png');
 await sharp(svg(440,280,'<circle cx="405" cy="250" r="180" fill="#e7e9df"/><text x="32" y="58" fill="#b95332" font-size="15" font-family="sans-serif">HISTORY SWEEP</text><text x="30" y="132" fill="#292e26" font-size="46" font-family="Georgia">A little less</text><text x="30" y="183" fill="#b95332" font-size="46" font-family="Georgia" font-style="italic">history.</text><path d="M325 212h42m-15-15 16 15-16 15" stroke="#b95332" stroke-width="3" fill="none"/><text x="32" y="246" fill="#73766b" font-size="11" font-family="sans-serif">SELECT ALL. CLEAR IN BATCHES.</text>')).flatten({background:'#f7f5ef'}).removeAlpha().png().toFile(root+'store/assets/promo-small-440x280.png');
 await sharp(svg(1400,560,'<circle cx="1130" cy="280" r="350" fill="#e7e9df"/><circle cx="1130" cy="280" r="250" stroke="#cdd1c0" fill="none"/><text x="90" y="110" fill="#b95332" font-family="sans-serif" font-size="20" letter-spacing="4">HISTORY SWEEP</text><text x="86" y="265" fill="#292e26" font-family="Georgia" font-size="94">Make room for</text><text x="86" y="368" fill="#b95332" font-family="Georgia" font-style="italic" font-size="94">what’s next.</text><text x="90" y="461" fill="#73766b" font-family="sans-serif" font-size="23">Thoughtful history cleanup. Entirely on your device.</text><rect x="996" y="171" width="200" height="230" rx="15" fill="#fffdf8" transform="rotate(9 1096 286)"/><path d="M1037 227h100m-100 34h65m-65 34h35m43 50 75-92m-35 2 37-3 3 36" stroke="#b95332" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')).flatten({background:'#f7f5ef'}).removeAlpha().png().toFile(root+'store/assets/promo-marquee-1400x560.png');
 console.log('Generated icons, English/Chinese product screenshots, and store promotional images.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
