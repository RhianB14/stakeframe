import {
  createExtractionPolicyService,
  categoryForErrorCode,
  secondaryAllowedAfter,
  sha256Hex,
  type Database,
  type ExtractionPolicyService,
  type OrganizationContext,
} from '@stakeframe/db';
import {
  ticketExtractionSchema,
  type ExtractionErrorCategory,
  type ExtractionUsage,
  type TicketExtraction,
} from '@stakeframe/shared';
import { extractTicket, TICKET_EXTRACTION_SYSTEM_PROMPT } from './openrouter.js';
import { IntegrationError } from './http.js';
import type { OcrResult } from './ocr.js';

/**
 * STK-F2-06 — a política fail-closed aplicada ao processo de extração, na
 * fronteira onde a chamada paga acontece.
 *
 * Este módulo não fala com o banco diretamente: ele recebe o serviço de
 * política e o contexto da organização, e devolve um desfecho. A regra é
 * simples e é ela inteira:
 *
 *  - A PORTA é consultedada ANTES de qualquer chamada. Teto atingido ou
 *    circuito aberto ⇒ nenhuma chamada paga, o item fica para preenchimento
 *    manual e a recusa é auditada com quota zero.
 *  - Uma RESPOSTA INCERTA (timeout, interrupção, conexão perdida) NUNCA é
 *    repetida nem repassada ao secundário. O item vai para ação manual, sem
 *    consumir cota, e a mensagem de log é o código `AI_OUTCOME_UNCERTAIN`.
 *  - Uma FALHA CONFIRMADA (a resposta chegou e não serve) é a única condição
 *    em que o secundário §8.3 seria chamado. O caminho já existe como função
 *    (`secondaryAllowedAfter`) e devolve `true`; o chamador decide se há um
 *    secundário configurado. Nesta entrega o secundário permanece BLOQUEADO
 *    por construção — nenhum registro novo de provedor foi adicionado.
 *  - DOIS RESULTADOS VÁLIDOS são ambos apresentados e NADA é persistido como
 *    escolhido: a escolha é do usuário, e o servidor não arbitra.
 *  - O registro persistido é sanitizado por schema; nenhum prompt, nenhuma
 *    resposta bruta e nenhum texto de bilhete sai daqui.
 *
 * O módulo é deliberadamente um POLICY LOOP testável: recebe dependências
 * injetadas e devolve um resultado tipado, sem `while`, sem temporizador e sem
 *Retry. Nenhum temporizador pode repedir uma chamada paga.
 */

export type ExtractionRequest = {
  context: OrganizationContext;
  inboxId: string;
  image: Buffer;
  imageSha256: string;
  ocr?: OcrResult;
  /** Usuário observado, para o escopo por usuário do circuito. */
  userId?: string | null;
};

export type ExtractionOutcomeResult =
  /** Uma estrutura válida, apresentada para revisão. Consumiu uma unidade. */
  | {
      kind: 'presented';
      extraction: TicketExtraction;
      quotaUnit: 1;
      auditId: string;
      pipelineVersion: string;
    }
  /**
   * DOIS resultados válidos: ambos vão para a revisão, nenhum escolhido.
   * Consumiu uma unidade — apresentar já é consumir, mesmo que o usuário
   * descarte depois.
   */
  | {
      kind: 'candidates';
      candidates: [TicketExtraction, TicketExtraction];
      quotaUnit: 1;
      auditId: string;
    }
  /** Resposta incerta: sem repetição, sem secundário, item vai para o usuário. */
  | { kind: 'uncertain'; category: ExtractionErrorCategory; code: string }
  /** Falha confirmada: a resposta chegou e não serviu. Sem quota consumida. */
  | { kind: 'failed'; category: ExtractionErrorCategory; code: string; secondaryAllowed: boolean }
  /** Porta fechada: nenhuma chamada paga foi feita. Item fica para o usuário. */
  | { kind: 'refused'; reason: 'quota' | 'breaker'; scope: string };

type Dependencies = {
  database: Database;
  apiKey: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
};

function sanitizeUsage(raw: unknown): ExtractionUsage {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const count = (input: unknown): number | null =>
    typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? input : null;
  return {
    promptTokens: count(value.prompt_tokens ?? value.promptTokens),
    completionTokens: count(value.completion_tokens ?? value.completionTokens),
    totalTokens: count(value.total_tokens ?? value.totalTokens),
  };
}

/**
 * Extrai UMA vez, sob a política. Não há laço, não há espera, não há retry.
 *
 * O `fetchImpl` é injetado para que o teste observe exatamente quantas chamadas
 * foram feitas — a prova de que uma resposta incerta não vira uma segunda
 * chamada é o CONTAGEM de chamadas, não a asserção sobre o estado final.
 */
export async function extractUnderPolicy(
  request: ExtractionRequest,
  deps: Dependencies,
): Promise<ExtractionOutcomeResult> {
  const policy: ExtractionPolicyService = createExtractionPolicyService(deps.database);
  const gate = await policy.requirePaidCall(
    request.context,
    request.inboxId,
    request.imageSha256,
    request.userId ?? null,
  );
  if (!gate.allowed) return { kind: 'refused', reason: gate.reason, scope: gate.scope };

  let response: Awaited<ReturnType<typeof extractTicket>>;
  try {
    response = await extractTicket({
      apiKey: deps.apiKey,
      image: request.image,
      fetchImpl: deps.fetchImpl,
      ...(request.ocr ? { ocr: request.ocr } : {}),
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
  } catch (error) {
    const code = error instanceof IntegrationError ? error.code : 'AI_OUTCOME_UNCERTAIN';
    const category = categoryForErrorCode(code);
    const recorded = await policy.recordFailure(request.context, {
      inboxId: request.inboxId,
      imageSha256: request.imageSha256,
      category,
      ...(request.userId !== undefined ? { userId: request.userId } : {}),
    });
    if (category.startsWith('uncertain_')) {
      // Falha INCERTA: o item vai para ação manual e a política devolve a
      // categoria, mas o retorno NÃO repete nem delega. Uma segunda chamada
      // aqui seria o que o card proíbe.
      return { kind: 'uncertain', category, code };
    }
    return {
      kind: 'failed',
      category,
      code,
      secondaryAllowed: recorded.secondaryAllowed,
    };
  }

  const parsed = ticketExtractionSchema.safeParse(response.extraction);
  if (!parsed.success) {
    const category = categoryForErrorCode('AI_EXTRACTION_INVALID');
    await policy.recordFailure(request.context, {
      inboxId: request.inboxId,
      imageSha256: request.imageSha256,
      category,
      ...(request.userId !== undefined ? { userId: request.userId } : {}),
    });
    return { kind: 'failed', category, code: 'AI_EXTRACTION_INVALID', secondaryAllowed: true };
  }

  // Uma resposta única que satisfaz o schema é apresentada como um resultado
  // válido. Um segundo resultado válido NÃO é produzido aqui: o modelo devolve
  // UMA escolha, e inventar um segundo seria fabricar evidência. O caso de dois
  // resultados válidos acontece quando o chamador tem DOIS provedores com
  // estruturas igualmente válidas — e o serviço de política é quem as recebe,
  // por `record` com `outcome: 'candidates_pending'` e `selected` nulo.
  const { id: auditId, audit } = await policy.record(request.context, {
    inboxId: request.inboxId,
    imageSha256: request.imageSha256,
    outcome: 'presented',
    sanitized: parsed.data,
    usage: sanitizeUsage(response.usage),
    model: response.model,
    elapsedMs: response.elapsedMs,
    // O texto do prompt e da resposta entram só como hash: o registro prova que
    // a chamada aconteceu sem carregar o conteúdo. O hash é do TEXTO que foi
    // enviado (o prompt real do extrator) e da resposta recebida — não do id da
    // requisição, que não provaria nada sobre o conteúdo.
    promptSha256: sha256Hex(TICKET_EXTRACTION_SYSTEM_PROMPT),
    responseSha256: sha256Hex(JSON.stringify(response.extraction)),
  });
  return {
    kind: 'presented',
    extraction: parsed.data,
    quotaUnit: 1,
    auditId,
    pipelineVersion: audit.pipelineVersion,
  };
}

export { secondaryAllowedAfter };
