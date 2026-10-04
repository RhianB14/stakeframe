// STK-F3-04 — um 401 só é sessão expirada quando a rota É a sessão.
//
// O evento `stakeframe:session-expired` limpa o cache do produto inteiro
// (`App.tsx` → `removeQueries({ queryKey: ['product'] })`), e `ProductApp`
// desmonta a árvore enquanto `/workspace` não volta. Tratar qualquer 401 como
// sessão derrubava a tela de quem estava lendo as apostas por causa de uma
// rota de recurso que responde 401 por desenho, e o ciclo se repetia a cada
// nova consulta — o navegador reclamava "element was detached from the DOM".
//
// Estes testes exercitam o `request` DE VERDADE (não só a função): a correção
// só vale se o evento parar de sair para recurso E continuar saindo para
// sessão. Testar só um dos lados passaria mesmo com o outro quebrado.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { request, isSessionRoute } from '../../apps/web/src/product/api.js';

const schema = { parse: (value: unknown) => value };

/** Substitui window/fetch por uma resposta 401 e registra os eventos. */
function fake401(body = '{}') {
  const dispatched: string[] = [];
  vi.stubGlobal('window', {
    dispatchEvent: (event: Event) => {
      dispatched.push(event.type);
      return true;
    },
  });
  vi.stubGlobal('fetch', async () => new Response(body, { status: 401 }));
  return dispatched;
}

describe('401 de rota: recurso não é sessão', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('(a) um 401 de RECURSO não derruba o produto — só vira SUSPEITA', async () => {
    const dispatched = fake401();
    // A lista é o que impede o ciclo: `/import-batches` e
    // `/polymarket/favorites` foram as duas observadas na captura de rede que
    // originou a correção; as duas respondem 401 por desenho.
    const recursos = [
      '/api/v1/import-batches',
      '/api/v1/polymarket/favorites',
      '/api/v1/workspace',
      '/api/v1/reports',
      '/api/v1/telegram/session',
    ];
    for (const url of recursos) {
      await expect(request(url, schema)).rejects.toThrow();
      // NENHUM `session-expired`: quem está lendo as apostas continua de pé.
      // O que sai é a suspeita, que pede confirmação no `/me`.
      expect(dispatched).toEqual(['stakeframe:session-suspected']);
      dispatched.length = 0;
    }
  });

  it('(b) um 401 de SESSÃO derruba o produto direto, sem passar por suspeita', async () => {
    const dispatched = fake401();
    await expect(request('/api/v1/me', schema)).rejects.toThrow();
    // O evento sai: a sessão morreu e o produto inteiro tem que sair com ela.
    expect(dispatched).toEqual(['stakeframe:session-expired']);
  });

  it('(c) a query string não muda a decisão — o caminho é o que decide', () => {
    expect(isSessionRoute('/api/v1/me?refetch=1')).toBe(true);
    expect(isSessionRoute('/api/v1/import-batches?page=1&pageSize=25')).toBe(false);
  });

  it('(d) o 401 de recurso continua legível pelo componente que pediu', async () => {
    const dispatched = fake401(
      JSON.stringify({
        error: {
          code: 'AUTH_NOT_CONFIGURED',
          message: 'Recurso não liberado para esta conta.',
          requestId: '00000000-0000-4000-8000-000000000000',
        },
      }),
    );
    // O 401 não deixou de ser erro: ele continua LOCAL, com status e código
    // para a tela que pediu decidir o que dizer. Só deixou de ser sessão.
    await expect(request('/api/v1/import-batches', schema)).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_NOT_CONFIGURED',
    });
    expect(dispatched).toEqual(['stakeframe:session-suspected']);
  });

  it('(e) a consulta decorativa não sugere nem derruba', async () => {
    const dispatched = fake401();
    await expect(
      request('/api/v1/polymarket/favorites', schema, {}, { decorative: true }),
    ).rejects.toThrow();
    expect(dispatched).toEqual([]);
  });
});
