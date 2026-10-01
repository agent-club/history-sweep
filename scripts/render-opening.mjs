import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {bundle} from '@remotion/bundler';
import {renderMedia, renderStill, selectComposition} from '@remotion/renderer';

const root = resolve(import.meta.dirname, '..');
const entryPoint = resolve(root, 'remotion/index.jsx');
const outDir = resolve(root, 'site/assets');
const browserExecutable = process.env.HISTORY_SWEEP_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const bundleDir = await mkdtemp(join(tmpdir(), 'history-sweep-opening-'));

try {
  const serveUrl = await bundle({entryPoint, outDir: bundleDir, publicDir: null, enableCaching: false});
  for (const lang of ['en', 'zh']) {
    const inputProps = {lang};
    const composition = await selectComposition({serveUrl, id: 'Opening', inputProps, browserExecutable});
    const stem = `opening-${lang}`;
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      crf: 22,
      pixelFormat: 'yuv420p',
      concurrency: 2,
      inputProps,
      outputLocation: join(outDir, `${stem}.mp4`),
      browserExecutable,
      audioCodec: null,
    });
    await renderStill({
      composition,
      serveUrl,
      inputProps,
      frame: 135,
      imageFormat: 'png',
      output: join(outDir, `${stem}.png`),
      browserExecutable,
    });
  }
} finally {
  await rm(bundleDir, {recursive: true, force: true});
}
