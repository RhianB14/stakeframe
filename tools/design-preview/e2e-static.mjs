/**
 * STK-F2-18 (Fase 4) — servidor ESTÁTICO puro do bundle web, para o e2e.
 *
 * O CI sobe o stack completo (`pnpm local:up`: API, Postgres, worker) e roda
 * o Playwright contra `127.0.0.1:8088`. Docker não está disponível nesta
 * máquina, e o e2e não precisa dele: os 58 `page.route` do `product.test.ts`
 * interceptam toda a API, então o único insumo real do navegador é o bundle
 * de `apps/web/dist`.
 *
 * Este servidor entrega exatamente esse bundle e NADA mais — qualquer
 * `/api/*` que chegar sem mock responde 404, o que transforma um mock
 * faltando em falha explícita em vez de um dado silenciosamente errado.
 * Para payload com valor de verdade, o servidor é `server.mjs`.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DIST = join(ROOT, 'apps', 'web', 'dist');
const PORT = Number(process.env.E2E_STATIC_PORT ?? 8088);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  if (path.startsWith('/api/')) {
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'api_requires_mock' }));
    return;
  }
  // SPA por hash: qualquer rota que não é arquivo devolve o index.
  const file = extname(path) ? join(DIST, path) : join(DIST, 'index.html');
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('não encontrado');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`bundle estatico para o e2e: http://127.0.0.1:${PORT}`);
});
