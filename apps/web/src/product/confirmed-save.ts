import type { TicketKind } from '@stakeframe/shared';

// STK-G0-23-R1 — a revisão do Codex mostrou que o formulário completo do Mini
// App mandava TUDO pelo PATCH do rascunho. Como o PATCH não é capaz de
// atualizar o registro financeiro, campos que JÁ têm comando canônico (casa,
// tipster, origem/crédito e data) acabavam recusados pelo fail-closed — e o
// usuário era informado, de forma genérica, de que tudo era imutável.
//
// Este módulo é puro de propósito: o roteamento campo→comando é decidido ANTES
// de qualquer escrita e é testável sem servidor, sem navegador e sem fuso.

export type FormValues = {
  origin: 'real' | 'freebet' | 'hibrida';
  credit: string;
  bookmaker: string;
  tipster: string;
  eventAt: string | null;
  stake: string;
  odds: string;
  sport: string;
  tournament: string;
  country: string;
  ticketKind: TicketKind;
  selections: { event: string | null; market: string | null; selection: string | null }[];
};

// Campos que NÃO têm comando canônico para aposta já confirmada. Não entram
// em "todos os campos são imutáveis": cada um é nomeado na mensagem.
export type BlockedConfirmedField = 'stake' | 'odds' | 'selections' | 'sport' | 'tipsterClear';

export type ConfirmedSaveInput = {
  completionState: 'incomplete' | 'complete';
  // Seleções do registro canônico em ordem; a data é gravada por seleção.
  selectionIds: string[];
  // Valor com que a tela ABRIU — é a linha de base para detectar a edição.
  baseline: FormValues;
  current: FormValues;
};

// STK-G0-23-R2 — o corpo NÃO carrega `version`. O plano é montado antes de
// qualquer escrita, e cada comando canônico DEPOIS incrementa a versão da inbox:
// congelar aqui a versão da montagem fazia o PATCH chegar obsoleto e o servidor
// recusar por VERSION_CONFLICT. Quem envia é quem sabe a versão vigente, então o
// chamador injeta `version` no momento do envio.
export type DraftPatch = {
  tournament: string | null;
  country: string | null;
  ticketKind: TicketKind;
} & Partial<{
  betOrigin: FormValues['origin'];
  freebetId: string | null;
  eventAt: string | null;
  bookmakerId: string | null;
  tipsterId: string | null;
  sport: string | null;
  stake: string;
  odds: string;
  selections: FormValues['selections'];
}>;

export type ConfirmedPlan = {
  // true → a aposta já está registrada: os campos que mudaram vão pelos
  // comandos canônicos (ou são bloqueados) e o PATCH leva os inalterados +
  // metadados do rascunho.
  canonical: boolean;
  blocked: BlockedConfirmedField[];
  origin: { kind: FormValues['origin']; freebetId?: string } | null;
  bookmaker: string | null;
  tipster: string | null;
  dates: { selectionId: string; eventAt: string | null }[];
  patch: DraftPatch;
};

const sameSelections = (a: FormValues['selections'], b: FormValues['selections']) =>
  a.length === b.length &&
  a.every(
    (item, index) =>
      (item.event ?? '') === (b[index]?.event ?? '') &&
      (item.market ?? '') === (b[index]?.market ?? '') &&
      (item.selection ?? '') === (b[index]?.selection ?? ''),
  );

export function planConfirmedSave(input: ConfirmedSaveInput): ConfirmedPlan {
  const { completionState, selectionIds, baseline, current } = input;
  const canonical = completionState === 'complete';

  const usesCredit = (origin: FormValues['origin']) => origin === 'freebet' || origin === 'hibrida';

  // Metadados do rascunho: não têm contrapartida canônica, continuam no PATCH.
  const metadataPatch = {
    tournament: current.tournament.trim() || null,
    country: current.country.trim() || null,
    ticketKind: current.ticketKind,
  };

  if (!canonical) {
    // Aposta ainda não registrada: o PATCH é quem completa o registro, então
    // segue levando tudo — como sempre fez.
    return {
      canonical: false,
      blocked: [],
      origin: null,
      bookmaker: null,
      tipster: null,
      dates: [],
      patch: {
        ...metadataPatch,
        betOrigin: current.origin,
        freebetId: usesCredit(current.origin) ? current.credit || null : null,
        eventAt: current.eventAt,
        bookmakerId: current.bookmaker || null,
        tipsterId: current.tipster || null,
        sport: current.sport.trim() || null,
        stake: current.stake,
        odds: current.odds,
        selections: current.selections,
      },
    };
  }

  const blocked: BlockedConfirmedField[] = [];
  if (current.stake !== baseline.stake) blocked.push('stake');
  if (current.odds !== baseline.odds) blocked.push('odds');
  if (!sameSelections(current.selections, baseline.selections)) blocked.push('selections');
  if (current.sport !== baseline.sport) blocked.push('sport');
  if (current.tipster !== baseline.tipster && current.tipster === '') blocked.push('tipsterClear');

  const originChanged =
    current.origin !== baseline.origin ||
    (usesCredit(current.origin) && current.credit !== baseline.credit);
  const bookmakerChanged =
    current.bookmaker !== baseline.bookmaker && current.bookmaker.trim() !== '';
  const tipsterChanged =
    current.tipster !== baseline.tipster &&
    current.tipster.trim() !== '' &&
    !blocked.includes('tipsterClear');
  const dateChanged = current.eventAt !== baseline.eventAt;
  const anythingBlocked = blocked.length > 0;

  const routeOrigin = originChanged && !anythingBlocked;
  const routeBookmaker = bookmakerChanged && !anythingBlocked;
  const routeTipster = tipsterChanged && !anythingBlocked;
  const routeDate = dateChanged && !anythingBlocked;

  // O PATCH de uma aposta confirmada volta a levar os campos que o usuário NÃO
  // mexeu, com o valor vigente. Isso preserva o rascunho tal como o contrato do
  // "salvar sem mudança" exige — e, como o valor enviado é idêntico ao
  // canônico, o fail-closed não o recusa. O que foi alterado é que sai daqui:
  // ou tem comando canônico (casa, tipster, origem/crédito, data) ou é
  // bloqueado antes de qualquer escrita.
  //
  // eventAt e sport ficam de fora SEMPRE neste modo: a linha de base deles é a
  // visão do rascunho (inbox), não a do registro, então enviá-los equivaleria a
  // declarar uma divergência que não é do usuário. A data roteia pelo comando
  // canônico; o esporte é bloqueado se mudar.
  const patch: DraftPatch = {
    ...metadataPatch,
    ...(routeOrigin
      ? {}
      : {
          betOrigin: current.origin,
          freebetId: usesCredit(current.origin) ? current.credit || null : null,
        }),
    ...(routeBookmaker ? {} : { bookmakerId: current.bookmaker || null }),
    ...(routeTipster ? {} : { tipsterId: current.tipster || null }),
    ...(blocked.includes('stake') ? {} : { stake: current.stake }),
    ...(blocked.includes('odds') ? {} : { odds: current.odds }),
    ...(blocked.includes('selections') ? {} : { selections: current.selections }),
  };

  return {
    canonical: true,
    blocked,
    origin: routeOrigin
      ? usesCredit(current.origin)
        ? { kind: current.origin, freebetId: current.credit }
        : { kind: current.origin }
      : null,
    bookmaker: routeBookmaker ? current.bookmaker : null,
    tipster: routeTipster ? current.tipster : null,
    dates: routeDate
      ? selectionIds.map((selectionId) => ({ selectionId, eventAt: current.eventAt }))
      : [],
    patch,
  };
}

const joinLabels = (labels: string[]) =>
  labels.length <= 1
    ? (labels[0] ?? '')
    : `${labels.slice(0, -1).join(', ')} e ${labels.at(-1) ?? ''}`;

const FIELD_LABELS: Record<BlockedConfirmedField, string> = {
  stake: 'valor apostado',
  odds: 'odd total',
  selections: 'texto das seleções',
  sport: 'esporte',
  tipsterClear: 'remover o tipster',
};

// Mensagem por campo bloqueado — nunca genérica. Os dois limites financeiros
// (valor e odd) explicam POR QUE não têm comando, em vez de dizer que a tela
// inteira é imutável.
export function refusalMessage(blocked: BlockedConfirmedField[]): string {
  if (!blocked.length) return '';
  const list = joinLabels(blocked.map((field) => FIELD_LABELS[field]));
  const parts: string[] = [];
  const financial = blocked.filter((field) => field === 'stake' || field === 'odds');
  if (financial.length) {
    const names = financial.map((field) => FIELD_LABELS[field]);
    const named =
      names.length === 1 ? `O ${names[0]}` : `O ${names[0]} e a ${names.slice(1).join(' e a')}`;
    parts.push(
      `${named} desta aposta já confirmada continuam fixados no registro financeiro: não existe comando canônico para alterá-los e mudá-los mudaria exposição, liquidação e histórico — isso exige decisão de produto.`,
    );
  }
  const others = blocked.filter((field) => field !== 'stake' && field !== 'odds');
  if (others.length) {
    parts.push(
      `Não há comando canônico para alterar ${joinLabels(others.map((field) => FIELD_LABELS[field]))} de uma aposta já confirmada.`,
    );
  }
  if (parts.length > 1) parts.splice(1, 0, `Também foi pedido: ${list}.`);
  return `${parts.join(' ')} Nada foi salvo.`;
}

// Falha depois de uma ação já persistida: nomeia o que entrou e o que não
// entrou, e deixa explícito que o Mini App NÃO foi fechado.
export function partialFailureMessage(saved: string[], failed: string, reason: string): string {
  const savedList = saved.join(', ');
  return `Alteração parcial — o Mini App não foi fechado e nada além disso foi gravado. Salvo: ${savedList}. Não aplicado: ${failed}. ${reason}`.trim();
}
