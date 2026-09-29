import { createHash } from 'node:crypto';
import {
  categoryForErrorCode,
  createExtractionPolicyService,
  createFinanceService,
  createImportDraftService,
  createImportService,
  createTenantContext,
  createTelegramTicketService,
  type Database,
  type OrganizationContext,
} from '@stakeframe/db';
import {
  TEXT_PIPELINE_VERSION,
  potentialReturnFor,
  telegramTextIsWithinBounds,
  textBetDraftSchema,
  ticketExtractionSchema,
  type ExtractionErrorCategory,
  type ExtractionUsage,
  type TextBetDraft,
} from '@stakeframe/shared';
import { IntegrationError } from './http.js';
import {
  TEXT_REGISTRATION_SYSTEM_PROMPT,
  readTextBet,
  textRegistrationHashes,
} from './telegram-text-reader.js';
import {
  createTelegramClient,
  telegramTextConfirmButtons,
  type TelegramConfig,
} from './telegram.js';

/**
 * STK-F2-07 — o registro por texto em PT-BR, do texto do usuário até o PREVIEW.
 *
 * Este módulo é a superfície nova, e ele tem exatamente uma regra que o
 * diferencia de todo o resto do worker:
 *
 *   **NENHUMA escrita financeira acontece aqui. Nem em sucesso, nem em falha,
 *   nem por omissão.** O que ele faz é:
 *
 *    1. RECEBER o texto livre do remetente autorizado;
 *    2. LER o texto uma única vez, sob a MESMA política fail-closed da STK-F2-06
 *       (porta antes da chamada, sem retry, sem repetição após resposta
 *       incerta, cota debitada só na apresentação);
 *    3. GRAVAR um rascunho de texto — igual em natureza ao de foto, um
 *       `integration.inbox` em `review`, sem aposta e sem lançamento;
 *    4. PUBLICAR o preview com os mesmos botões da STK-F2-05 (Confirmar, Editar,
 *       Descartar), mais a identidade determinística para duplicata.
 *
 * A aposta nasce exclusivamente quando o USUÁRIO toca em Confirmar — o que
 * chama `confirmDraft`, o mesmo caminho do Mini App, que monta o comando
 * `import.confirm` canônico e o entrega ao serviço financeiro, que revalida
 * casa, origem, crédito, campos e duplicata no servidor. Não existe caminho
 * onde o texto vire lançamento sozinho, e a ausência desse caminho é o que o
 * teste de §15 prova.
 *
 * A PORTA é consultada ANTES de qualquer chamada. Teto atingido ou circuito
 * aberto ⇒ nenhuma chamada paga, o texto vai para ação manual e a recusa é
 * auditada com quota zero — a regra da STK-F2-06 aplicada sem exceção. Falha de
 * IA NUNCA consome cota e NUNCA repete: o item fica para o usuário preencher à
 * mão.
 *
 * NADA DE CONTEÚDO VAI AO LOG. Um texto livre é, por definição, conteúdo que o
 * usuário digitou e que pode conter qualquer coisa. Nem o texto, nem a estrutura
 * lida, nem a legenda: só códigos sanitizados.
 */

type Client = ReturnType<typeof createTelegramClient>;

const ORGANIZATION_SETTING = 'app.organization_id';

/** Identidade do registro textual: o texto normalizado, e nada mais. */
export function telegramTextIdentity(text: string): string {
  const normalized = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');
  return createHash('sha256').update(`telegram:text:${normalized}`).digest('hex');
}

/**
 * Chave idempotente da decisão, por rascunho + versão. Mesmo formato UUID que o
 * serviço financeiro exige; repetir o mesmo toque converge no mesmo recibo.
 */
export const telegramTextDecisionKey = (inboxId: string, version: number) => {
  const digest = createHash('sha256')
    .update(`telegram:text-decision:${inboxId}:${version}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20, 32)}`;
};

/**
 * STK-F2-13: `spend` entrou na união porque a porta agora considera também o
 * TETO DE GASTO (R$200/mês), e não só a cota por apresentação. O destino é o
 * mesmo de `quota` e `breaker` — recusa de orçamento, não de conteúdo — então
 * o handler já cai no ramo "pausada, registre pelo Mini App" sem mudança.
 */
export type TextRegistration =
  | { kind: 'presented'; inboxId: string; chatId: number; messageId: number; delivered: boolean }
  | { kind: 'duplicate'; inboxId: string; duplicateOf: string }
  | {
      kind: 'refused';
      reason: 'quota' | 'breaker' | 'spend' | 'bounds';
      scope?: string;
    }
  | { kind: 'uncertain'; category: ExtractionErrorCategory; code: string }
  | { kind: 'failed'; category: ExtractionErrorCategory; code: string };

/** Leitura mínima do rascunho textual — sem escrita, sem extrato, sem PII. */
export type TextPreview = {
  state: string;
  version: number;
  stake: string | null;
  odds: string | null;
  reference: string | null;
  bookmaker: string | null;
  tipster: string | null;
  sentAt: string | null;
  potentialReturn: string | null;
  duplicateDetected: boolean;
  selections: { event: string | null; market: string | null; selection: string | null }[];
  warnings: string[];
};

const normalizeName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ');

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

export function createTelegramTextRegistration(
  database: Database,
  client: Client,
  config: TelegramConfig,
  deps: { apiKey: string | null; fetchImpl?: typeof fetch; signal?: AbortSignal },
) {
  const tenant = createTenantContext(database);
  const policy = createExtractionPolicyService(database);
  const finance = createFinanceService(database);
  const imports = createImportService(database);
  const tickets = createTelegramTicketService(database);
  const draft = createImportDraftService(database);

  /**
   * Resolve um NOME declarado em texto contra o catálogo ATIVO da organização.
   *
   * É alias exato ou nome exato sob a normalização de alias do produto
   * (minúsculas, sem acento, espaços colapsados). Nome desconhecido vira
   * `null` e o preview mostra "pendente": NUNCA um cadastro novo criado em
   * silêncio a partir de texto livre.
   */
  async function resolveCatalogName(
    context: OrganizationContext,
    kind: 'bookmaker' | 'tipster',
    name: string | null,
  ): Promise<{ id: string; name: string } | null> {
    if (!name) return null;
    const wanted = normalizeName(name);
    const rows = await tenant.withOrganizationTransaction(
      context,
      async (db) =>
        (
          await db.query<{ catalog_id: string; name: string }>(
            `select a.catalog_id,c.name from finance.catalog_alias a
               join finance.catalog c on c.id=a.catalog_id and c.organization_id=a.organization_id
              where a.organization_id=current_setting($1, true)::uuid and a.kind=$2 and c.active
              order by c.name asc, c.id asc limit 50`,
            [ORGANIZATION_SETTING, kind],
          )
        ).rows,
      { isolation: 'repeatable read' },
    );
    const match = rows.find((row) => normalizeName(row.name) === wanted);
    return match ? { id: match.catalog_id, name: match.name } : null;
  }

  /**
   * Leitura do rascunho textual. Nenhuma escrita, e nada sai daqui além do que
   * o próprio preview mostra ao dono da conta.
   */
  async function preview(
    context: OrganizationContext,
    inboxId: string,
  ): Promise<TextPreview | null> {
    const row = await tenant.withOrganizationTransaction(
      context,
      async (db) =>
        (
          await db.query<{
            state: string;
            version: number;
            extraction: unknown;
            telegram_received_at: Date | null;
            bookmaker: string | null;
            tipster: string | null;
            override_stake: string | null;
            override_odds: string | null;
            reference: string | null;
            duplicate: boolean;
          }>(
            `select i.state,i.version,i.extraction,i.telegram_received_at,
                    (select name from finance.catalog c where c.id=i.bookmaker_override_id
                      and c.organization_id=i.organization_id) as bookmaker,
                    (select name from finance.catalog t where t.organization_id=i.organization_id
                      and t.kind='tipster' and t.active
                      and t.id::text=(i.metadata->'userOverrides'->>'tipsterId')) as tipster,
                    i.metadata->'userOverrides'->>'stake' as override_stake,
                    i.metadata->'userOverrides'->>'odds' as override_odds,
                    i.extraction->'text'->>'reference' as reference,
                    exists(select 1 from integration.inbox other
                            where other.organization_id=i.organization_id
                              and other.telegram_identity=i.telegram_identity
                              and other.id<>i.id and other.state not in ('discarded')) as duplicate
               from integration.inbox i
              where i.organization_id=current_setting($1, true)::uuid and i.id=$2`,
            [ORGANIZATION_SETTING, inboxId],
          )
        ).rows[0],
      { isolation: 'repeatable read' },
    );
    if (!row) return null;
    // A leitura vive no formato CANÔNICO de extração (o mesmo do rascunho de
    // foto), e é lida com o schema dele. Os nomes de casa e tipster NÃO vêm
    // daqui: vêm do override resolvido contra o catálogo, porque um nome
    // declarado no texto é uma intenção, não um cadastro.
    const parsed = ticketExtractionSchema.safeParse(row.extraction);
    const parsedDraft = parsed.success ? parsed.data : null;
    // O override canônico (o que o servidor gravou) tem precedência sobre o
    // lido — é a mesma precedência do rascunho de foto na STK-F2-05.
    const stake = row.override_stake ?? parsedDraft?.stake ?? null;
    const odds = row.override_odds ?? parsedDraft?.odds ?? null;
    return {
      state: row.state,
      version: row.version,
      stake,
      odds,
      reference: parsedDraft?.reference ?? null,
      bookmaker: row.bookmaker,
      tipster: row.tipster,
      sentAt: row.telegram_received_at ? row.telegram_received_at.toISOString() : null,
      // O retorno potencial é calculado no SERVIDOR (stake × odd), nunca lido
      // do texto: é a mesma regra da STK-G0-20.
      potentialReturn: stake && odds ? potentialReturnFor('real', stake, odds, null) : null,
      duplicateDetected: row.duplicate,
      selections: (parsedDraft?.selections ?? []).map((selection) => ({
        event: selection.event,
        market: selection.market,
        selection: selection.selection,
      })),
      warnings: parsedDraft?.warnings ?? [],
    };
  }

  /**
   * Cria o rascunho ANTES de qualquer chamada paga, em estado `pending` e sem
   * extração. A ordem não é um detalhe de implementação: é a semântica de
   * "ação manual" do card. Um item recusado por cota ou com leitura falhada
   * PRECISA existir para o usuário preencher à mão — e a auditoria da F2-06
   * exige um `inbox_id` real, porque `integration.extraction_audit` tem chave
   * estrangeira para o bilhete. Um item que só existe depois da leitura seria
   * invisível justamente no caso em que o usuário precisa dele.
   */
  async function createDraft(
    context: OrganizationContext,
    input: {
      text: string;
      chatId: number;
      messageId: number;
      receivedAt: Date;
      identity: string;
    },
  ): Promise<
    | { state: 'duplicate'; inboxId: string; duplicateOf: string }
    | {
        state: 'created';
        inboxId: string;
        version: number;
      }
  > {
    return tenant.withOrganizationTransaction(context, async (db) => {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `telegram-text-identity:${input.identity}`,
      ]);
      const original = (
        await db.query<{ id: string }>(
          `select id from integration.inbox
            where organization_id=current_setting($1, true)::uuid and telegram_identity=$2
              and state not in ('discarded')
            order by created_at asc, id asc limit 1`,
          [ORGANIZATION_SETTING, input.identity],
        )
      ).rows[0];
      if (original)
        return { state: 'duplicate' as const, inboxId: original.id, duplicateOf: original.id };
      // Um registro textual não tem imagem: `sha256` é NOT NULL e carrega a
      // identidade determinística do próprio texto; `image` e `attachment_id`
      // ficam nulos (a coluna é anulável e não há anexo para reter, exportar
      // ou apagar).
      const inserted = (
        await db.query<{ id: string; version: number }>(
          // `id` é gerado AQUI, e não por um DEFAULT: a coluna tem default no
          // drizzle mas a migração 0001 a cria sem DEFAULT, e um default que
          // existe só na aplicação é um default que não existe no banco.
          `insert into integration.inbox
             (id,organization_id,source_key,image,attachment_id,sha256,caption,metadata,state,
              bet_origin,event_date_status,telegram_chat_id,telegram_source_message_id,telegram_received_at,
              telegram_sync_state,telegram_queue_state,telegram_identity,telegram_queued_at,
              extraction_pipeline_version)
           values (gen_random_uuid(),current_setting($1, true)::uuid,$2,null,null,$3,$4,$5,'pending',
              'real','pending',$6,$7,$8,'pending','none',$9,now(),$10)
           returning id,version`,
          [
            ORGANIZATION_SETTING,
            `telegram:text:${input.identity}`,
            input.identity,
            // A legenda é a superfície de CONTEXTO que o servidor já usa para
            // declarar casa/tipster, e a confirmação manual mostra o que foi
            // lido. Ela é privada da organização e nunca é logada nem auditada.
            input.text.slice(0, 1024),
            JSON.stringify({ source: 'telegram-text', pipelineVersion: TEXT_PIPELINE_VERSION }),
            input.chatId,
            input.messageId,
            input.receivedAt,
            input.identity,
            TEXT_PIPELINE_VERSION,
          ],
        )
      ).rows[0];
      return {
        state: 'created' as const,
        inboxId: inserted!.id,
        version: inserted!.version,
      };
    });
  }

  /**
   * Marca o item como preenchimento manual.
   *
   * `failed` é o estado que a F2-05 já usa para "o usuário precisa agir": é ele
   * que o Mini App mostra com a ação de preenchimento, e é ele que
   * `retry` consome para uma releitura EXPLÍCITA. Sem esta marcação, um texto
   * recusado por cota ou com leitura falhada ficaria `pending` para sempre — o
   * usuário veria um item que nunca avança e nunca poderia corrigir.
   *
   * `error_code` recebe um CÓDIGO da política, nunca o erro do fornecedor.
   */
  async function markManual(context: OrganizationContext, inboxId: string): Promise<void> {
    await tenant.withOrganizationTransaction(context, async (db) => {
      await db.query(
        `update integration.inbox
            set state='failed', error_code='TELEGRAM_TEXT_MANUAL_ENTRY_REQUIRED',
                version=version+1, updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2 and state='pending'`,
        [ORGANIZATION_SETTING, inboxId],
      );
    });
  }

  /**
   * Grava a leitura sobre o rascunho já criado e o move para `review`.
   *
   * A leitura é gravada no FORMATO CANÔNICO de extração (`ticketExtractionSchema`),
   * e não num formato próprio do texto. Isso não é conveniência: é o que faz o
   * `confirmDraft` da F2-05 — o único caminho de escrita financeira — aceitar o
   * rascunho, porque ele valida o rascunho contra aquele schema. Um formato
   * textual próprio exigiria um segundo caminho de confirmação, e dois caminhos
   * de confirmação são exatamente o defeito que o card proíbe.
   *
   * O que a conversão NÃO faz, campo por campo, é a lista de proibições:
   *
   *  - `potentialReturn` é SEMPRE `null`: o retorno é calculado no servidor a
   *    partir de stake × odd, e um valor vindo do texto seria um número que
   *    ninguém calculou;
   *  - `freebet` é SEMPRE `null`: a origem financeira é declaração do usuário,
   *    escolhida no preview, e o texto não a decide;
   *  - `placedAtText` é o instante da MENSAGEM ORIGINAL, que o servidor já
   *    conhece — a data do jogo é outra etapa e nunca é inferida;
   *  - nenhum campo de casa ou tipster: eles vão como override canônico,
   *    resolvidos por alias contra o catálogo ativo, e nome desconhecido vira
   *    `null` (o preview mostra "pendente"), nunca cadastro novo.
   */
  async function applyDraft(
    context: OrganizationContext,
    input: { inboxId: string; draft: TextBetDraft; identity: string; receivedAt: Date },
  ): Promise<void> {
    const canonical = ticketExtractionSchema.parse({
      reference: input.draft.reference,
      placedAtText: input.receivedAt.toISOString(),
      currency: 'BRL',
      stake: input.draft.stake,
      odds: input.draft.odds,
      // O texto NUNCA fornece o retorno potencial, a modalidade, a casa nem a
      // data do jogo. Três `null` explícitos são o registro dessa recusa.
      potentialReturn: null,
      freebet: null,
      selections: input.draft.selections.map((selection) => ({
        // A F2-05 grava `'A definir'` no campo ausente e o `confirmDraft`
        // RECUSA a confirmação enquanto algum campo for esse marcador. É a
        // regra correta aqui também: um evento que o texto não traz não pode
        // ser inventado nem vir `null` — o texto é a evidência, e sem ele o
        // campo é pendente por definição.
        event: selection.event ?? 'A definir',
        sport: selection.sport,
        market: selection.market ?? 'A definir',
        selection: selection.selection ?? 'A definir',
        odds: selection.odds,
        // Reservado e depreciado (mesmo contrato da extração de imagem): a
        // data do evento é declaração do usuário, nunca transcrição.
        eventDateText: null,
      })),
      // O aviso do texto é "não deu para ler", e é copiado. O que ele nunca
      // contém é conselho, análise ou palpite — não há campo para isso.
      warnings: input.draft.warnings,
    });
    await tenant.withOrganizationTransaction(context, async (db) => {
      await db.query(
        `update integration.inbox
            set state='review', extraction=$3, telegram_queue_state='preview',
                extraction_prompt_sha256=$4, extraction_response_sha256=$5, version=version+1,
                updated_at=now()
          where organization_id=current_setting($1, true)::uuid and id=$2 and state='pending'`,
        [
          ORGANIZATION_SETTING,
          input.inboxId,
          JSON.stringify(canonical),
          // O hash do prompt é o do PROMPT ENVIADO, não o do sistema: um prompt
          // fixo teria o mesmo hash para sempre e a auditoria pararia de
          // distinguir uma leitura de outra.
          createHash('sha256')
            .update(`${TEXT_REGISTRATION_SYSTEM_PROMPT}\n${input.identity}`)
            .digest('hex'),
          createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
        ],
      );
    });
  }

  /**
   * Publica o preview do rascunho textual — os mesmos botões da STK-F2-05. A
   * primeira linha diz, sem ambiguidade, que NADA foi lançado: o usuário precisa
   * saber que a aposta existe só depois de Confirmar.
   */
  async function announce(context: OrganizationContext, inboxId: string): Promise<boolean> {
    const data = await preview(context, inboxId);
    if (!data) return false;
    const instantFormat = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short',
    });
    const money = (value: string) => (value.includes(',') ? value : value.replace('.', ','));
    const orPending = (value: string | null) => value ?? 'pendente';
    const text = [
      '📝 REGISTRO POR TEXTO — nada foi lançado ainda',
      'Confira o que li antes de confirmar.',
      '',
      `🏠 Casa: ${orPending(data.bookmaker)}`,
      `🗣️ Tipster: ${orPending(data.tipster)}`,
      `💰 Valor Apostado: ${data.stake ? `R$ ${money(data.stake)}` : 'pendente'}`,
      `🎲 Odd: ${data.odds ? money(data.odds) : 'pendente'}`,
      `💵 Retorno Potencial: ${
        data.potentialReturn ? `R$ ${money(data.potentialReturn)}` : 'pendente'
      }`,
      `🔖 Referência: ${orPending(data.reference)}`,
      `📅 Enviado em: ${data.sentAt ? instantFormat.format(new Date(data.sentAt)) : 'pendente'}`,
      '',
      ...data.selections.map(
        (selection, index) =>
          `${index + 1}. ${orPending(selection.market)} · ${orPending(selection.selection)}${
            selection.event ? ` @ ${selection.event}` : ''
          }`,
      ),
      ...(data.warnings.length ? ['', ...data.warnings.map((warning) => `⚠️ ${warning}`)] : []),
      ...(data.duplicateDetected
        ? ['', '⚠️ Possível duplicata. Confirmar aqui registra um segundo lançamento.']
        : []),
      '',
      '✅ Confirmar registra a aposta e o lançamento financeiro.',
      '✏️ Editar abre os campos para corrigir.',
      '🗑️ Descartar arquiva por 30 dias (não é apagado).',
    ].join('\n');
    try {
      const sent = await client.sendMessage(Number(config.chatId), text, {
        buttons: telegramTextConfirmButtons(config.miniAppUrl, inboxId),
      });
      // O id da mensagem de preview é o que torna o botão decidível: o
      // callback chega com chat + message_id e nenhum outro vínculo. Ele mora
      // em `metadata` (jsonb) porque `telegram_result_message_id` pertence à
      // mensagem de resultado e a outbox a usa para decidir se já entregou.
      await tenant.withOrganizationTransaction(context, async (db) => {
        await db.query(
          `update integration.inbox
              set metadata=jsonb_set(metadata,'{telegramPreviewMessageId}',to_jsonb($3::bigint),true),
                  updated_at=now()
            where organization_id=current_setting($1, true)::uuid and id=$2`,
          [ORGANIZATION_SETTING, inboxId, String(sent.messageId)],
        );
      });
      return true;
    } catch {
      // Falha de entrega nunca desfaz o rascunho: ele continua decidível pelo
      // Mini App e pelo preview do site.
      return false;
    }
  }

  /**
   * Confirmação pelo botão. Não cria aposta sozinho: chama o MESMO
   * `confirmDraft` da STK-F2-05, que monta o `import.confirm` a partir do
   * rascunho canônico e o entrega ao serviço financeiro. Faltando casa, valor ou
   * odd, a resposta é `incomplete` e o preview continua aberto para edição.
   */
  async function confirm(
    context: OrganizationContext,
    inboxId: string,
    version: number,
  ): Promise<
    | { state: 'confirmed'; betId: string; version: number }
    | { state: 'already' | 'discarded' | 'duplicate' | 'incomplete'; blockedReason?: string }
  > {
    const data = await preview(context, inboxId);
    if (!data) return { state: 'incomplete', blockedReason: 'TELEGRAM_TICKET_NOT_FOUND' };
    if (data.state === 'imported') return { state: 'already' };
    if (data.state === 'discarded') return { state: 'discarded' };
    if (data.duplicateDetected)
      return { state: 'duplicate', blockedReason: 'DUPLICATE_REVIEW_REQUIRED' };
    if (!data.stake || !data.odds) return { state: 'incomplete', blockedReason: 'FIELDS_PENDING' };
    const settings = await finance.workspace(context);
    if (!settings.initialized) return { state: 'incomplete', blockedReason: 'NOT_INITIALIZED' };
    const applied = await imports.confirmDraft(
      context,
      inboxId,
      { version },
      'telegram:bot',
      telegramTextDecisionKey(inboxId, version),
    );
    return { state: 'confirmed', betId: applied.betId, version: applied.version };
  }

  /** Descarta com arquivo recuperável de 30 dias — igual à foto. */
  async function discard(context: OrganizationContext, inboxId: string) {
    return tickets.archive(context, inboxId, 'discarded');
  }

  /**
   * O ponto de entrada: uma mensagem de texto livre do remetente autorizado.
   *
   * A ordem É a regra, e ela tem cinco passos:
   *
   *   1. o rascunho EXISTE (`pending`), para que a ação manual tenha onde
   *      acontecer e para que a auditoria tenha um item ao qual se ligar;
   *   2. a PORTA é consultada ANTES de qualquer chamada paga;
   *   3. UMA chamada, sem retry e sem delegação;
   *   4. falha INCERTA não repete e não consome cota; apresentação debita uma
   *      unidade;
   *   5. em NENHUM caminho há escrita financeira — a aposta nasce do toque em
   *      Confirmar.
   */
  async function register(input: {
    context: OrganizationContext;
    text: string;
    chatId: number;
    messageId: number;
    receivedAt: Date;
  }): Promise<TextRegistration> {
    if (!telegramTextIsWithinBounds(input.text)) return { kind: 'refused', reason: 'bounds' };
    const identity = telegramTextIdentity(input.text);
    const created = await createDraft(input.context, {
      text: input.text,
      chatId: input.chatId,
      messageId: input.messageId,
      receivedAt: input.receivedAt,
      identity,
    });
    if (created.state === 'duplicate')
      return { kind: 'duplicate', inboxId: created.inboxId, duplicateOf: created.duplicateOf };

    // Sem chave de IA a leitura não existe, mas o rascunho continua lá: é
    // exatamente o item de ação manual que o card pede, e o usuário o
    // preenche pelo Mini App sem depender de nenhuma chamada paga.
    if (!deps.apiKey) {
      await markManual(input.context, created.inboxId);
      return { kind: 'refused', reason: 'bounds' };
    }

    const gate = await policy.requirePaidCall(input.context, created.inboxId, identity, null);
    if (!gate.allowed) {
      await markManual(input.context, created.inboxId);
      return { kind: 'refused', reason: gate.reason, scope: gate.scope };
    }

    let response: Awaited<ReturnType<typeof readTextBet>>;
    try {
      response = await readTextBet({
        apiKey: deps.apiKey,
        text: input.text,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    } catch (error) {
      const code = error instanceof IntegrationError ? error.code : 'AI_OUTCOME_UNCERTAIN';
      const category = categoryForErrorCode(code);
      await policy.recordFailure(input.context, {
        inboxId: created.inboxId,
        imageSha256: identity,
        category,
      });
      await markManual(input.context, created.inboxId);
      // Falha INCERTA e falha CONFIRMADA recebem o mesmo destino: ação manual,
      // sem cota, sem segunda chamada. O que muda é a categoria registrada e o
      // fato de a confirmada alimentar o circuit breaker — decisão do serviço de
      // política, não deste módulo.
      return { kind: 'uncertain', category, code };
    }

    const parsed = textBetDraftSchema.safeParse(response.draft);
    if (!parsed.success) {
      await policy.recordFailure(input.context, {
        inboxId: created.inboxId,
        imageSha256: identity,
        category: 'confirmed_response',
      });
      await markManual(input.context, created.inboxId);
      // A resposta chegou e não serve: é falha CONFIRMADA, cota zero, e o
      // item fica para preenchimento manual.
      return { kind: 'failed', category: 'confirmed_response', code: 'AI_EXTRACTION_INVALID' };
    }

    await applyDraft(input.context, {
      inboxId: created.inboxId,
      draft: parsed.data,
      identity,
      receivedAt: input.receivedAt,
    });
    const house = await resolveCatalogName(input.context, 'bookmaker', parsed.data.bookmakerName);
    const tipster = await resolveCatalogName(input.context, 'tipster', parsed.data.tipsterName);
    // Casa e tipster resolvidos vão para o override canônico do rascunho (o
    // mesmo caminho do PATCH da STK-G0-19-R7), revalidados contra o catálogo
    // ativo dentro da transação. Não resolvido FICA NULO: o preview mostra
    // "pendente" e o usuário escolhe no Mini App.
    //
    // As SELEÇÕES não entram aqui de propósito: elas já foram gravadas no
    // formato canônico por `applyDraft`, e repetir o override com o mesmo
    // conteúdo sobrescreveria o marcador `'A definir'` por `null` — trocando
    // "pendente, o usuário preenche" por "campo inválido, a confirmação falha
    // com erro". Valor e odd vão porque o servidor os gravou; as seleções já
    // estão gravadas.
    await draft.updateDraft(
      input.context,
      created.inboxId,
      {
        version: created.version + 1,
        bookmakerId: house?.id ?? null,
        tipsterId: tipster?.id ?? null,
        stake: parsed.data.stake,
        odds: parsed.data.odds,
      },
      'telegram:bot',
    );

    // A auditoria recebe os hashes — nunca o texto. `presented` debita a
    // unidade: apresentar já é consumir, mesmo que o usuário descarte depois.
    // `sanitized` fica NULO de propósito: o schema da auditoria da F2-06 é o
    // da EXTRAÇÃO DE IMAGEM (`ticketExtractionSchema`), e uma estrutura textual
    // não cabe nele. A ausência do campo é a prova estrutural de que a
    // auditoria não tem onde guardar o rascunho do usuário.
    const hashes = textRegistrationHashes(input.text, parsed.data);
    await policy.record(input.context, {
      inboxId: created.inboxId,
      imageSha256: identity,
      outcome: 'presented',
      usage: sanitizeUsage(response.usage),
      model: response.model,
      elapsedMs: response.elapsedMs,
      promptSha256: hashes.textSha256,
      responseSha256: hashes.responseSha256,
    });
    const delivered = await announce(input.context, created.inboxId);
    return {
      kind: 'presented',
      inboxId: created.inboxId,
      chatId: input.chatId,
      messageId: input.messageId,
      delivered,
    };
  }

  return { register, confirm, discard, preview };
}
