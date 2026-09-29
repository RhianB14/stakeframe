import {
  createReportService,
  createTenantContext,
  systemOrganizationContext,
  type Database,
  type OrganizationContext,
} from '@stakeframe/db';
import {
  TELEGRAM_COMMANDS,
  cents,
  formatReportBRL,
  money,
  reportPrivateLink,
  saoPauloDate,
  telegramPeriod,
  type AnalyticsDashboard,
  type ReportMetrics,
  type TelegramCommand,
} from '@stakeframe/shared';
import { TelegramOperationError, createTelegramClient, type TelegramConfig } from './telegram.js';

/**
 * STK-F2-07 — os onze comandos do Telegram, e as consultas por trás deles.
 *
 * O card pede "consultas estatísticas limitadas", e a palavra que importa é
 * LIMITADAS. Ela é implementada em três camadas que não se sobrepõem:
 *
 *  - A CONSULTA é limitada por período. Toda janela nasce de um instante
 *    INJETADO e é fechada em datas de São Paulo: um dia, sete dias ou o mês
 *    corrente até hoje. Não existe "últimas 24 horas" nem "período livre": o
 *    relatório trabalha por data de evento em São Paulo, e qualquer outra base
 *    mentiria sobre o que está somando.
 *
 *  - A MÉTRICA vem do mesmo serviço de relatório da STK-F2-02 (`dashboard`),
 *    que já é uma agregação única indexada com cache curto. Nada aqui
 *    reconstrói histórico, nada cria materialized view, e nada repete o que o
 *    relatório já calcula.
 *
 *  - A RESPOSTA é limitada em tamanho: as listas são cortadas em dez linhas e
 *    dizem explicitamente quantas faltam, em vez de despejar o histórico inteiro
 *    num chat.
 *
 * E o limite mais importante não é de volume: é de AUDIÊNCIA. Toda esta
 * superfície só responde a partir do contexto de organização do DONO
 * VINCULADO, resolvido pelo vínculo da STK-F2-04. Não há caminho pelo qual um
 * comando mostre o número de outra organização, e nenhum dos onze comandos
 * escreve: são todos de LEITURA. A escrita é o preview da F2-05, com
 * confirmação humana explícita.
 */

type Client = ReturnType<typeof createTelegramClient>;
const ORGANIZATION_SETTING = 'app.organization_id';
/** Uma resposta de Telegram tem teto prático; a lista é cortada, nunca omitida. */
const MAX_LIST_ROWS = 10;

const brl = (value: string) => formatReportBRL(value);
const percent = (value: string | null) =>
  value === null ? 'sem base' : `${value.replace('.', ',')}%`;

const periodTitle: Record<'hoje' | 'semana' | 'mes', string> = {
  hoje: 'HOJE',
  semana: 'ÚLTIMOS 7 DIAS',
  mes: 'MÊS ATUAL',
};

/**
 * Uma métrica só é dita com o N ao lado. É a regra da STK-F2-02 (`lowSample`)
 * aplicada ao chat: abaixo do limiar o número sozinho é ruído, e o usuário
 * precisa saber que é.
 */
function metricsLines(metrics: ReportMetrics, minSample: number): string[] {
  const low = metrics.bets < minSample;
  return [
    `🎲 Apostas: ${metrics.bets}${low ? ` (amostra pequena; mínimo ${minSample})` : ''}`,
    `💰 Resultado: ${brl(metrics.profit)}`,
    `📉 ROI: ${percent(metrics.roiReal)}`,
    `🎯 Yield: ${percent(metrics.yieldReal)}`,
    `💵 Retornos: ${brl(metrics.realReturns)}`,
    `💸 Exposição aberta: ${brl(metrics.exposure)}`,
    `✅ Liquidadas: ${metrics.settledBets} · ⏳ Abertas: ${metrics.openBets}`,
  ];
}

const HELP = [
  '📖 Comandos disponíveis:',
  '',
  '/hoje — resultado de hoje',
  '/semana — últimos 7 dias',
  '/mes — mês atual',
  '/banca — saldo, exposição e resultado do mês',
  '/pendentes — apostas aguardando resultado',
  '/fila — processamento em andamento',
  '/exportar — onde baixar CSV e JSON na sua conta',
  '/relatorio — onde abrir o relatório na sua conta',
  '/casa — casas cadastradas',
  '/tipster — tipsters cadastrados',
  '/config — unitário e situação da conta',
  '',
  'Você também pode descrever a aposta por escrito: eu leio o texto, mostro um preview e só registro depois que você confirmar.',
].join('\n');

export function createTelegramCommands(
  database: Database,
  client: Client,
  config: TelegramConfig,
  deps: { fetchImpl?: typeof fetch; now?: () => Date } = {},
) {
  const tenant = createTenantContext(database);
  const reports = createReportService(database);

  /**
   * O contexto de ORGANIZAÇÃO é o do dono vinculado, resolvido pelo vínculo da
   * STK-F2-04 — nunca um id de ambiente e nunca um id vindo do payload. Sem
   * organização fundadora o bot não tem o que responder, e a resposta é a
   * orientação de link, não um erro.
   */
  async function context(): Promise<OrganizationContext | null> {
    const founder = await tenant.founderOrganizationId();
    return founder ? systemOrganizationContext(founder) : null;
  }

  async function send(text: string): Promise<void> {
    try {
      await client.sendMessage(Number(config.chatId), text);
    } catch (error) {
      if (!(error instanceof TelegramOperationError)) throw error;
      // Nenhum detalhe de transporte sai daqui: a falha do Telegram não é do
      // comando e não interessa ao usuário.
      console.warn(`TELEGRAM_COMMAND_SEND_FAILED ${error.code}`);
    }
  }

  async function readBankroll(ctx: OrganizationContext): Promise<string[]> {
    const rows = await tenant.withOrganizationTransaction(
      ctx,
      async (db) =>
        (
          await db.query<{ kind: string; name: string; balance: string }>(
            `select a.kind,a.name,coalesce(sum(p.amount),0)::numeric(16,2)::text as balance
               from finance.account a
               left join finance.posting p on p.account_id=a.id
              where a.organization_id=current_setting($1, true)::uuid
                and a.kind in ('reserve','bookmaker','exposure')
              group by a.id, a.kind, a.name
              order by a.kind, a.name`,
            [ORGANIZATION_SETTING],
          )
        ).rows,
      { isolation: 'repeatable read' },
    );
    // A banca disponível é a soma das contas de DINHEIRO (reserva e casas) e
    // NUNCA inclui a exposição: somar as duas trataria valor bloqueado como
    // valor em mãos. A exposição é dita, à parte, como o que está no jogo.
    const available = rows
      .filter((row) => row.kind !== 'exposure')
      .reduce((sum, row) => sum + cents(row.balance), 0n);
    const exposure = rows.find((row) => row.kind === 'exposure');
    return [
      `💵 Disponível: ${brl(money(available))}`,
      ...rows
        .filter((row) => row.kind !== 'exposure')
        .map((row) => `🏦 ${row.name}: ${brl(row.balance)}`),
      ...(exposure ? [`💸 Exposição em jogo: ${brl(exposure.balance)}`] : []),
    ];
  }

  async function readOpenBets(
    ctx: OrganizationContext,
  ): Promise<{ total: number; lines: string[] }> {
    const rows = await tenant.withOrganizationTransaction(
      ctx,
      async (db) =>
        (
          await db.query<{
            total: string;
            bookmaker: string;
            stake: string;
            odds: string;
            selection: string | null;
          }>(
            // A população é a de apostas ABERTAS, sem recorte de data: o que
            // está aberto continua aberto, e filtrar por data esconderia
            // justamente as apostas que este comando existe para mostrar. O
            // isolamento por organização é a mesma cláusula do relatório, e
            // apostas canceladas nunca aparecem.
            `select count(*) over() as total,
                    c.name as bookmaker,
                    b.stake::text as stake,
                    b.odds::text as odds,
                    (select s.selection from finance.selection s
                      where s.organization_id=b.organization_id and s.bet_id=b.id
                      order by s.position limit 1) as selection
               from finance.bet b
               join finance.catalog c on c.id=b.bookmaker_id and c.organization_id=b.organization_id
              where b.organization_id=current_setting($1, true)::uuid
                and b.state='open' and b.completion_state='complete'
              order by b.placed_at desc, b.id desc limit $2`,
            [ORGANIZATION_SETTING, MAX_LIST_ROWS],
          )
        ).rows,
      { isolation: 'repeatable read' },
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      lines: rows.map(
        (row, index) =>
          `${index + 1}. ${row.bookmaker} · R$ ${row.stake.replace('.', ',')} @ ${row.odds.replace(
            '.',
            ',',
          )} · ${row.selection ?? 'sem seleção'}`,
      ),
    };
  }

  async function readQueue(ctx: OrganizationContext): Promise<{ total: number; items: string[] }> {
    const rows = await tenant.withOrganizationTransaction(
      ctx,
      async (db) =>
        (
          await db.query<{ id: string; total: string }>(
            // Só o que ainda NÃO virou aposta: um item importado é histórico do
            // produto, não fila. A fila é o que espera a decisão do usuário.
            `select id,count(*) over() as total from integration.inbox
              where organization_id=current_setting($1, true)::uuid
                and state in ('pending','processing','review')
                and imported_bet_id is null
              order by created_at asc, id asc limit $2`,
            [ORGANIZATION_SETTING, MAX_LIST_ROWS],
          )
        ).rows,
      { isolation: 'repeatable read' },
    );
    return {
      total: rows.length ? Number(rows[0]!.total) : 0,
      items: rows.map((row) => `🆔 ${row.id}`),
    };
  }

  async function readCatalog(
    ctx: OrganizationContext,
    kind: 'bookmaker' | 'tipster',
  ): Promise<string[]> {
    return tenant.withOrganizationTransaction(
      ctx,
      async (db) =>
        (
          await db.query<{ name: string }>(
            `select name from finance.catalog
              where organization_id=current_setting($1, true)::uuid and kind=$2 and active
              order by name asc limit $3`,
            [ORGANIZATION_SETTING, kind, MAX_LIST_ROWS + 1],
          )
        ).rows.map((row) => row.name),
      { isolation: 'repeatable read' },
    );
  }

  async function readSettings(
    ctx: OrganizationContext,
    now: Date,
  ): Promise<{
    initialized: boolean;
    unitPercent: string | null;
    currentUnit: string | null;
    accounts: number;
  }> {
    return tenant.withOrganizationTransaction(
      ctx,
      async (db) => {
        const row = (
          await db.query<{ initialized: boolean; unit_percent: string }>(
            'select initialized,unit_percent from finance.settings where organization_id=current_setting($1, true)::uuid',
            [ORGANIZATION_SETTING],
          )
        ).rows[0];
        // O mês do unitário é o de São Paulo, o mesmo corte do relatório: lido
        // pelo fuso UTC, o unitário apontaria para o mês errado na virada.
        const unit = (
          await db.query<{ amount: string }>(
            'select amount from finance.monthly_unit where organization_id=current_setting($1, true)::uuid and month=$2',
            [ORGANIZATION_SETTING, saoPauloDate(now).slice(0, 7)],
          )
        ).rows[0];
        const accounts = (
          await db.query<{ count: string }>(
            `select count(*)::text as count from finance.account
              where organization_id=current_setting($1, true)::uuid and kind in ('reserve','bookmaker')`,
            [ORGANIZATION_SETTING],
          )
        ).rows[0];
        return {
          initialized: row?.initialized ?? false,
          unitPercent: row?.unit_percent ?? null,
          currentUnit: unit?.amount ?? null,
          accounts: Number(accounts?.count ?? 0),
        };
      },
      { isolation: 'repeatable read' },
    );
  }

  /**
   * Cada comando é uma LEITURA. A função devolve o texto e nada mais: quem
   * decide como enviar é o chamador, o que torna o conjunto testável sem
   * Telegram e impede que um comando escreva por acidente.
   */
  async function read(command: TelegramCommand): Promise<string> {
    const ctx = await context();
    if (!ctx) return '⚠️ Nenhuma conta vinculada. Vincule sua conta no site para usar os comandos.';
    const now = deps.now ? deps.now() : new Date();
    const base = config.miniAppUrl.replace(/#.*$/, '').replace(/\/+$/, '');

    if (command === 'hoje' || command === 'semana' || command === 'mes') {
      const period = telegramPeriod(command, now);
      const dashboard: AnalyticsDashboard = await reports.dashboard(ctx, {
        from: period.from,
        to: period.to,
        kind: 'all',
        includeEstimated: 'false',
      });
      return [
        `📊 ${periodTitle[command]}`,
        `📅 ${period.from} a ${period.to}`,
        '',
        ...metricsLines(dashboard.metrics, dashboard.minSample),
        '',
        'Relatório completo na sua conta: /relatorio',
      ].join('\n');
    }

    if (command === 'banca') {
      const today = saoPauloDate(now);
      const [dashboard, bank] = await Promise.all([
        reports.dashboard(ctx, {
          from: `${today.slice(0, 7)}-01`,
          to: today,
          kind: 'all',
          includeEstimated: 'false',
        }),
        readBankroll(ctx),
      ]);
      return [
        '💼 BANCA',
        '',
        ...bank,
        '',
        `📊 Resultado do mês: ${brl(dashboard.metrics.profit)}`,
        `📉 ROI do mês: ${percent(dashboard.metrics.roiReal)}`,
      ].join('\n');
    }

    if (command === 'pendentes') {
      const open = await readOpenBets(ctx);
      if (!open.total) return '✅ Nenhuma aposta aguardando resultado no momento.';
      return [
        `⏳ ABERTO: ${open.total} ${open.total === 1 ? 'aposta' : 'apostas'}`,
        '',
        ...open.lines,
        open.total > open.lines.length
          ? `…e mais ${open.total - open.lines.length}. Use /relatorio para ver tudo.`
          : 'Use /relatorio para ver tudo.',
      ].join('\n');
    }

    if (command === 'fila') {
      const queue = await readQueue(ctx);
      if (!queue.total) return '✅ Nada na fila: todo processamento foi concluído.';
      return [
        `⏳ FILA: ${queue.total} ${queue.total === 1 ? 'item' : 'itens'} aguardando decisão`,
        '',
        ...queue.items,
        '',
        'Nada foi lançado ainda: cada item passa por preview antes de virar aposta.',
      ].join('\n');
    }

    if (command === 'relatorio')
      // STK-F2-08 — o relatório passou a ser uma PÁGINA PRIVADA com snapshot
      // imutável, e este comando é o caminho até ela. O card exclui PDF,
      // e-mail e PNG, e o resumo em texto no chat seria transformar a conversa
      // em um canal de exportação de dado financeiro que ninguém pediu: o bot
      // entrega o endereço autenticado, nunca o conteúdo.
      //
      // O COMANDO NÃO GERA NADA. Ele não é a cadência automática (que é o job, e
      // depende do plano): é o caminho para o relatório que já está na conta.
      return [
        '📄 RELATÓRIO',
        '',
        'O relatório completo fica na sua conta, em página privada:',
        reportPrivateLink(config.miniAppUrl),
        '',
        'É uma página congelada no momento da emissão, com narrativa e histórico de versões.',
        'Exportações em CSV e JSON ficam na mesma conta.',
      ].join('\n');

    if (command === 'exportar')
      return [
        '📤 EXPORTAR',
        '',
        'Baixe o que quiser na sua conta, em página privada:',
        `${base}/exports`,
        '',
        'O bot não envia arquivo: o download fica na sua conta, com o mesmo controle de acesso dela.',
      ].join('\n');

    if (command === 'casa' || command === 'tipster') {
      const kind = command === 'casa' ? 'bookmaker' : 'tipster';
      const items = await readCatalog(ctx, kind);
      if (!items.length)
        return kind === 'bookmaker'
          ? '🏠 Nenhuma casa cadastrada ainda.'
          : '🗣️ Nenhum tipster cadastrado ainda.';
      return [
        kind === 'bookmaker' ? '🏠 CASAS CADASTRADAS' : '🗣️ TIPSTERS CADASTRADOS',
        '',
        ...items.slice(0, MAX_LIST_ROWS).map((item, index) => `${index + 1}. ${item}`),
        ...(items.length > MAX_LIST_ROWS ? [`…e mais ${items.length - MAX_LIST_ROWS}.`] : []),
      ].join('\n');
    }

    // /config — a situação da conta que o dono precisa para decidir registrar:
    // unitário vigente, se a banca foi inicializada e se o mês corrente já tem
    // unidade. Nenhuma chave, nenhum identificador, nenhum segredo.
    const settings = await readSettings(ctx, now);
    return [
      '⚙️ CONFIGURAÇÃO',
      '',
      `💼 Banca inicializada: ${settings.initialized ? 'sim' : 'não'}`,
      `📏 Unitário: ${settings.unitPercent ? brl(settings.unitPercent) : 'pendente'}`,
      `📅 Unidade do mês: ${settings.currentUnit ? brl(settings.currentUnit) : 'pendente'}`,
      `🏦 Contas de dinheiro: ${settings.accounts}`,
      '',
      'Ajustes de valor, depósitos e configuração ficam na sua conta.',
    ].join('\n');
  }

  /** Execução do comando, com a resposta sanitizada de falha. */
  async function run(command: TelegramCommand): Promise<void> {
    let text: string;
    try {
      text = await read(command);
    } catch {
      // Uma consulta que falha não pode derrubar o polling, e o usuário recebe
      // uma orientação genérica — nunca o erro, o SQL ou o conteúdo da tabela.
      text = '⚠️ Não consegui ler os dados agora. Tente de novo em instantes.';
      console.warn('TELEGRAM_COMMAND_FAILED');
    }
    await send(text);
  }

  /** Comando desconhecido: a lista do que existe, sem executar nada. */
  async function refuseUnknown(): Promise<void> {
    await send(
      '🤔 Esse comando não existe. Use /hoje, /semana, /mes, /banca, /pendentes, /fila, /exportar, /relatorio, /casa, /tipster ou /config.',
    );
  }

  /** A ajuda, acessível sem comando: o próprio texto lista os onze. */
  async function help(): Promise<void> {
    await send(HELP);
  }

  return { run, refuseUnknown, help, read, commands: TELEGRAM_COMMANDS };
}
