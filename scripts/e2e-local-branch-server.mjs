/**
 * STK-F3-BASE — serve a branch local para o harness E2E, sem tocar no stack.
 *
 * POR QUE EXISTE
 *
 * O `compose.local.yml` sobe `web` com a imagem JÁ CONSTRUÍDA: o bundle vai
 * dentro da imagem (`COPY --from=build /workspace/apps/web/dist /srv`) e o
 * serviço é `read_only`, sem bind-mount. Então `docker compose up` não passa a
 * servir a branch que está no disco — ele continua servindo o bundle de
 * quando a imagem foi construída. Rodar o E2E contra `:8088` depois de um
 * cherry-pick mede a imagem antiga, e uma falha assim não distingue
 * "código quebrado" de "código nem foi servido".
 *
 * ESTE SERVIÇOR
 *
 * Sobe o `apps/web/dist` da branch atual em uma porta livre e faz proxy de
 * `/api/*` e `/health/*` para o container que já está de pé. Assim o
 * `E2E_BASE_URL` do Playwright aponta para a branch em disco, e o resto do
 * ambiente (banco, API, fixtures) continua sendo o mesmo — que é o que mantém
 * a comparação com o baseline válida.
 *
 * NÃO é parte do produto: é ferramenta de verificação, e por isso mora em
 * `scripts/` e não entra no build da web.
 *
 * USO
 *   node scripts/e2e-local-branch-server.mjs [--port 8099] [--upstream http://127.0.0.1:8088]
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const port = Number(readArg('port', process.env.E2E_BRANCH_PORT ?? '8099'));
const upstream = readArg('upstream', process.env.E2E_UPSTREAM ?? 'http://127.0.0.1:8088');
const distDir = resolve(fileURLToPath(new URL('../apps/web/dist', import.meta.url)));

/**
 * O mesmo mapa de tipos que o Caddyfile.dev serve em produção. Sem isto o
 * navegador baixa o bundle como `application/octet-stream` e o ESM não
 * executa — a falha aparece como tela branca, não como erro de teste.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve um caminho pedido dentro de `dist`, recusando qualquer tentativa de
 * sair da raiz. Um servidor de arquivos estático que aceita `..` é um
 * servidor que entrega o `.env` do repositório; isto não precisa ser uma
 * superfície de leitura, mesmo em ferramenta local.
 */
async function resolveFile(pathname) {
  const decoded = decodeURIComponent(pathname);
  const candidate = resolve(join(distDir, normalize(decoded)));
  if (candidate !== distDir && !candidate.startsWith(distDir + sep)) return null;
  try {
    const info = await stat(candidate);
    if (info.isFile()) return candidate;
  } catch {
    // Cai no index.html abaixo: é rota de SPA, não erro.
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/health/')) {
    const target = `${upstream}${req.url}`;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstreamResponse = await fetch(target, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      });
      const body = Buffer.from(await upstreamResponse.arrayBuffer());
      res.writeHead(upstreamResponse.status, {
        'content-type': upstreamResponse.headers.get('content-type') ?? 'application/json',
      });
      res.end(body);
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }

  // `try_files {path} /index.html`: rota desconhecida é do cliente, não 404.
  const file = (await resolveFile(url.pathname)) ?? join(distDir, 'index.html');
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bundle ausente: rode `pnpm --filter @stakeframe/web build` antes');
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`branch local em http://127.0.0.1:${port} (api -> ${upstream})\n`);
});
