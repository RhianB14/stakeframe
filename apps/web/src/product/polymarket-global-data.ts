import { polymarketGlobalResponseSchema, type PolymarketGlobalResponse } from '@stakeframe/shared';

/**
 * STK-F3-04 — os DADOS LOCAIS da tela Global, e por que eles existem.
 *
 * A INTEGRAÇÃO ESTÁ PENDENTE. Esta tela ainda não está ligada a um endpoint:
 * o gate F2-18 não foi autorizado, e nada aqui finge que está. Os dados
 * abaixo são LOCAIS e COERENTES com o formato do contrato
 * (`polymarketGlobalResponseSchema`) — eles passam pelo MESMO parse que um
 * payload real passaria, e o teste os valida a cada execução. Se a integração
 * for autorizada, este arquivo é o que se substitui por uma chamada de rede,
 * e a tela não muda.
 *
 * Três decisões sobre o que estes dados FAZEM, porque elas são o que os
 * testes de navegador observam:
 *
 *  1) ESTRUTURA: três colunas no desktop, dois no tablet, um no mobile, com
 *     pelo menos um card em cada linha na largura de referência — senão o E2E
 *     não teria o que medir.
 *
 *  2) TRUNCAMENTO: um dos cards tem cobertura `truncated` com a métrica
 *     dependente BLOQUEADA. É o estado que o dono pediu para ver, e um
 *     catálogo sem ele não demonstraria a regra.
 *
 *  3) DESCONHECIDO: um dos cards tem métricas `null`. Sem ele, "Sem base"
 *     não teria prova na tela, e `null` é o estado que a R2 mais exige.
 *
 * Os decimais são LITERAIS de texto, como na F2-14: nenhum valor passa por
 * `Number()` para chegar aqui.
 */
const LOCAL_CARDS = {
  cards: [
    {
      proxyWallet: '0x1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
      userName: '@alpha_odds',
      avatarSeed: '@alpha_odds',
      scope: 'SPORTS' as const,
      rank: '1',
      pnl: { value: '48210.42', n: 1240 },
      volume: { value: '312000.5', n: 1240 },
      roi: { value: '34.2', n: 1240 },
      hitRate: { value: '61.4', n: 1240 },
      averageOdds: { value: '1.94', n: 1240 },
      followers: { value: '18420', n: 1240 },
      wins: { value: '761', n: 1240 },
      losses: { value: '479', n: 1240 },
      openBets: { value: '12', n: 1240 },
      monthlyUnits: { value: '184', n: 1240 },
      topMarket: 'Brasileirão Série A',
      coverage: { truncated: false, reason: null, roiBlocked: false },
    },
    {
      proxyWallet: '0x2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e',
      userName: '@pro_polymarket',
      avatarSeed: '@pro_polymarket',
      scope: 'ESPORTS' as const,
      rank: '2',
      pnl: { value: '41870.00', n: 980 },
      volume: { value: '254900.9', n: 980 },
      roi: { value: '28.9', n: 980 },
      hitRate: { value: '59.8', n: 980 },
      averageOdds: { value: '1.91', n: 980 },
      followers: { value: '9320', n: 980 },
      wins: { value: '586', n: 980 },
      losses: { value: '394', n: 980 },
      openBets: { value: '7', n: 980 },
      monthlyUnits: { value: '151', n: 980 },
      topMarket: 'Counter-Strike 2 · IEM Katowice',
      coverage: { truncated: false, reason: null, roiBlocked: false },
    },
    {
      // A COBERTURA TRUNCADA: o card que a R4 e o card exigem. O ROI é
      // bloqueado — nunca estimado, nunca zero. O motivo é escrito por
      // extenso, porque "bloqueado" sem razão é só uma palavra sem sentido.
      proxyWallet: '0x3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f',
      userName: '@politics_edge_do_mercado_de_bolas',
      avatarSeed: '@politics_edge_do_mercado_de_bolas',
      scope: 'SPORTS' as const,
      rank: '3',
      pnl: { value: '8940.11', n: 210 },
      volume: { value: '41000.0', n: 210 },
      roi: { value: '31.0', n: 210 },
      hitRate: { value: '55.2', n: 210 },
      averageOdds: { value: '2.04', n: 210 },
      followers: { value: '740', n: 210 },
      wins: { value: '116', n: 210 },
      losses: { value: '94', n: 210 },
      openBets: { value: '3', n: 210 },
      monthlyUnits: { value: '26', n: 210 },
      topMarket: 'NBA · apostas de intervalo',
      coverage: {
        truncated: true,
        reason: '210 de 1.000 eventos ingeridos nesta janela',
        roiBlocked: true,
      },
    },
    {
      // O DESCONHECIDO: `null` em três métricas. A taxa de acerto não foi
      // medida, os followers não constam na coleta e o mercado de maior
      // participação é desconhecido. Nada disso vira 0 nem célula vazia.
      proxyWallet: '0x4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
      userName: '@csgo_arb',
      avatarSeed: '@csgo_arb',
      scope: 'BOTH' as const,
      rank: '4',
      pnl: { value: '7310.55', n: 188 },
      volume: { value: '88900.2', n: 188 },
      roi: { value: '19.4', n: 188 },
      hitRate: { value: null, n: 188 },
      averageOdds: { value: '2.02', n: 188 },
      followers: { value: null, n: 188 },
      wins: { value: '96', n: 188 },
      losses: { value: '92', n: 188 },
      openBets: { value: null, n: 188 },
      monthlyUnits: { value: '18', n: 188 },
      topMarket: null,
      coverage: { truncated: false, reason: null, roiBlocked: false },
    },
    {
      proxyWallet: '0x5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7081',
      userName: '@edge_detector',
      avatarSeed: '@edge_detector',
      scope: 'SPORTS' as const,
      rank: '5',
      pnl: { value: '-12400.30', n: 340 },
      volume: { value: '198000.0', n: 340 },
      roi: { value: '-6.1', n: 340 },
      hitRate: { value: '46.8', n: 340 },
      averageOdds: { value: '2.21', n: 340 },
      followers: { value: '5210', n: 340 },
      wins: { value: '159', n: 340 },
      losses: { value: '181', n: 340 },
      openBets: { value: '5', n: 340 },
      monthlyUnits: { value: '-38', n: 340 },
      topMarket: 'Futebol inglês · Premier League',
      coverage: { truncated: false, reason: null, roiBlocked: false },
    },
    {
      proxyWallet: '0x6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192',
      userName: '@futebol_br',
      avatarSeed: '@futebol_br',
      scope: 'SPORTS' as const,
      rank: '6',
      pnl: { value: '5120.80', n: 96 },
      volume: { value: '22600.4', n: 96 },
      roi: { value: '22.7', n: 96 },
      hitRate: { value: '57.3', n: 96 },
      averageOdds: { value: '1.88', n: 96 },
      followers: { value: '3120', n: 96 },
      wins: { value: '55', n: 96 },
      losses: { value: '41', n: 96 },
      openBets: { value: '2', n: 96 },
      monthlyUnits: { value: '22', n: 96 },
      topMarket: 'Brasileirão Série A',
      coverage: { truncated: false, reason: null, roiBlocked: false },
    },
  ],
  source: 'local' as const,
  requested: 6,
  returned: 6,
};

/**
 * O payload local, PASSADO PELO CONTRATO antes de chegar à tela.
 *
 * O parse roda aqui e não no componente: se os dados locais divergirem do
 * schema, a falha acontece na carga do módulo com uma mensagem sobre o
 * contrato, e não na tela com uma mensagem sobre um elemento que não
 * apareceu. Ele também joga o dado por cima do tipo, que é o que impede um
 * card de ganhar um campo que o contrato não prevê.
 */
export const localPolymarketGlobal: PolymarketGlobalResponse =
  polymarketGlobalResponseSchema.parse(LOCAL_CARDS);
