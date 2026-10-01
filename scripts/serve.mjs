import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const types = { '.html':'text/html; charset=utf-8', '.mjs':'text/javascript', '.js':'text/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.mp4':'video/mp4', '.zip':'application/zip', '.json':'application/json' };
export function createServer() {
  return http.createServer(async (req,res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = path.resolve(root, '.' + pathname);
      if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(403); return res.end(); }
      if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-store');
      const data = await readFile(file);
      // Native video seeking needs byte ranges, including when switching localized films.
      if (path.extname(file) === '.mp4') {
        res.setHeader('Accept-Ranges', 'bytes');
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          const start = match?.[1] ? Number(match[1]) : match?.[2] ? Math.max(0, data.length - Number(match[2])) : NaN;
          const end = match?.[1] && match[2] ? Math.min(Number(match[2]), data.length - 1) : data.length - 1;
          if (!Number.isSafeInteger(start) || start < 0 || start >= data.length || end < start) {
            res.writeHead(416, {'Content-Range': `bytes */${data.length}`});
            return res.end();
          }
          res.writeHead(206, {'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1});
          return res.end(data.subarray(start, end + 1));
        }
      }
      res.setHeader('Content-Length', data.length);
      res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  createServer().listen(port, '127.0.0.1', () => console.log('History Sweep: http://127.0.0.1:' + port + '/site/'));
}
