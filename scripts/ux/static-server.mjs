// Servidor estatico minimo para o E2E local (SPA). Somente stdlib.
// A CI serve o mesmo dist pelo nginx do compose em 127.0.0.1:8088; aqui usamos
// o mesmo dist gerado por `pnpm --filter @stakeframe/web build`.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.argv[2];
const port = Number(process.argv[3] ?? 8088);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const requested = decodeURIComponent(url.pathname);
    const candidate = normalize(join(root, requested));
    if (!candidate.startsWith(normalize(root))) {
      res.writeHead(403).end('forbidden');
      return;
    }
    let file = candidate;
    try {
      const info = await stat(file);
      if (info.isDirectory()) file = join(file, 'index.html');
    } catch {
      file = join(root, 'index.html');
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`static server on http://127.0.0.1:${port} serving ${root}`);
});
