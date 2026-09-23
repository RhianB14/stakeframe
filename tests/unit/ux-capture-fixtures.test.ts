// As fixtures da auditoria visual STK-UX-01/02 devem ser payloads válidos
// contra os schemas reais: sem isso o React Query rejeita e a captura mostra
// "Não foi possível carregar os registros" em vez da tela auditada.
import { describe, expect, it } from 'vitest';
import {
  betPageSchema,
  importDetailSchema,
  reportSchema,
  workspaceSchema,
} from '../../packages/shared/src/index.js';
import { miniAppImport, richBets, richReport, richWorkspace } from '../ux-capture/fixtures.js';

describe('fixtures da auditoria visual', () => {
  it('workspace sintético é aceito por workspaceSchema', () => {
    expect(() => workspaceSchema.parse(richWorkspace())).not.toThrow();
  });

  it('relatório sintético é aceito por reportSchema', () => {
    expect(() => reportSchema.parse(richReport())).not.toThrow();
  });

  it('lista de apostas sintética é aceita por betPageSchema', () => {
    expect(() =>
      betPageSchema.parse({ items: richBets(), total: richBets().length, page: 1, pageSize: 25 }),
    ).not.toThrow();
  });

  it('detalhe do Mini App é aceito por importDetailSchema', () => {
    expect(() => importDetailSchema.parse(miniAppImport())).not.toThrow();
  });
});
