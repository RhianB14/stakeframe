import type { TelegramTicketPreview } from '@stakeframe/shared';

/**
 * STK-F2-05 — a mensagem de PREVIEW do bilhete.
 *
 * Esta mensagem é o produto da etapa que existe ANTES de qualquer escrita
 * financeira. Ela mostra o que o servidor leu da foto e o que ele ainda NÃO
 * decidiu, e oferece exatamente três saídas: confirmar, editar ou descartar.
 *
 * Duas datas aparecem com nomes que não deixam dúvida:
 *  - "Enviado em" é o instante da MENSAGEM ORIGINAL (`placedAt`), imutável;
 *  - "Evento em" é a data do JOGO, que nasce "pendente" e só é preenchida por
 *    declaração do usuário. Ela NUNCA é inferida da data de envio.
 *
 * Esta mensagem vai para o chat do dono com o conteúdo do bilhete dele. Por
 * isso ela é montada aqui e NUNCA é registrada em log: nenhuma chamada de
 * `console` recebe o texto, a legenda ou a extração.
 */

export type PreviewMessageRow = {
  chatId?: number | null;
  sourceMessageId: number | null;
  processingMessageId: number | null;
};

const instantFormat = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  dateStyle: 'short',
  timeStyle: 'short',
});

const formatInstant = (value: string | null) =>
  value === null ? null : instantFormat.format(new Date(value));

const orPending = (value: string | null) => value ?? 'pendente';
const displayMoney = (value: string) =>
  value.includes(',') ? value : value.replace('.', ',').replace(/,(\d)$/, ',$1');

const kindLabel = { simple: 'Simples', multiple: 'Múltipla', betbuild: 'BetBuild' } as const;
const originLabel = { real: 'Não', freebet: 'Freebet', hibrida: 'Híbrida' } as const;
const archiveLabel = {
  discarded: 'descartado por você',
  duplicate: 'duplicata de um bilhete anterior',
  superseded: 'substituído por um reenvio',
} as const;

/**
 * Renderiza o preview. A primeira linha diz, sem ambiguidade, que NADA foi
 * lançado ainda: o usuário precisa saber que a aposta existe só depois da
 * confirmação.
 */
export function buildPreviewMessage(
  input: {
    preview: TelegramTicketPreview;
  } & PreviewMessageRow,
): string {
  const preview = input.preview;
  const lines: string[] = [
    '🔎 PREVIEW — nada foi lançado ainda',
    '📸 Confira, edite ou descarte antes de confirmar.',
    '',
    `🆔 ID: ${preview.id}`,
    `⏳ Situação: ${preview.state === 'failed' ? 'Falha ao ler o bilhete' : 'Aguardando sua decisão'}`,
    '',
    `🏠 Casa: ${orPending(preview.bookmaker)}`,
    `🗣️ Tipster: ${orPending(preview.tipster)}`,
    `💰 Valor Apostado: ${preview.stake ? `R$ ${displayMoney(preview.stake)}` : 'pendente'}`,
    `🎲 Odd: ${preview.odds ? displayMoney(preview.odds) : 'pendente'}`,
    `💵 Retorno Potencial: ${
      preview.potentialReturn ? `R$ ${displayMoney(preview.potentialReturn)}` : 'pendente'
    }`,
    `📝 Tipo: ${kindLabel[preview.kind]}`,
    `🎁 Bônus: ${preview.origin ? originLabel[preview.origin] : 'pendente'}`,
    `🔖 Referência: ${orPending(preview.reference)}`,
    '',
    // Datas com semânticas distintas: envio é fato, evento é declaração.
    `📅 Enviado em: ${orPending(formatInstant(preview.sentAt))}`,
    `🎮 Evento em: ${
      preview.eventDateStatus === 'confirmed'
        ? orPending(formatInstant(preview.eventAt))
        : 'pendente (informe a data do jogo)'
    }`,
  ];
  if (preview.selections.length) {
    lines.push('');
    for (const [index, selection] of preview.selections.entries()) {
      const head = `${index + 1}.`;
      lines.push(
        `${head} ${orPending(selection.market)} · ${orPending(selection.selection)} @ ${orPending(
          normalizeEvent(selection.event),
        )}`,
      );
    }
  }
  if (preview.duplicate.detected) {
    const reason = preview.duplicate.reasons.includes('image')
      ? 'mesma imagem e contexto'
      : 'mesma referência informada';
    lines.push(
      '',
      `⚠️ Possível duplicata por ${reason}. Confirmar aqui registra um segundo lançamento.`,
    );
  }
  if (preview.blockedReason) {
    lines.push('', `⛔ ${blockedReasonLabel(preview.blockedReason)}`);
  }
  if (preview.archive.archived) {
    const reason = preview.archive.reason ? archiveLabel[preview.archive.reason] : 'arquivado';
    lines.push(
      '',
      `🗄️ Bilhete ${reason}. Recuperável até ${formatInstant(preview.archive.recoverableUntil)}.`,
    );
  }
  lines.push(
    '',
    '✅ Confirmar registra a aposta e o lançamento financeiro.',
    '✏️ Editar abre os campos para corrigir.',
    '🗑️ Descartar arquiva por 30 dias (não é apagado).',
  );
  return lines.join('\n');
}

const normalizeEvent = (value: string | null) =>
  value === null ? null : value.replace(/\s+/g, ' ').trim() || null;

const blockedReasonLabel = (reason: string): string => {
  switch (reason) {
    case 'EXTRACTION_FAILED':
      return 'Não conseguimos ler o bilhete. Use Retry para tentar de novo.';
    case 'EXTRACTION_PENDING':
      return 'A leitura do bilhete ainda está em andamento.';
    case 'FIELDS_PENDING':
      return 'Faltam valor e odd. Abra Editar para completar antes de confirmar.';
    default:
      return 'Confira os campos antes de confirmar.';
  }
};
