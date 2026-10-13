import { readDisplayPreferences } from './preferences.js';

// The preview keeps English as the source language. Only known interface copy
// is translated, so user-entered selections, events, teams and bookmaker names
// remain untouched.
const ptBR: Record<string, string> = {
  dashboard: 'Painel',
  bets: 'Apostas',
  'new bet': 'Nova aposta',
  bankroll: 'Banca',
  analytics: 'Análises',
  hedge: 'Proteção',
  settings: 'Configurações',
  calendar: 'Calendário',
  reports: 'Relatórios',
  profile: 'Perfil',
  inbox: 'Caixa de entrada',
  'global ranking': 'Ranking global',
  favorites: 'Favoritos',
  telegram: 'Telegram',
  simulation: 'Simulação',
  tipster: 'Tipster',
  overview: 'Visão geral',
  today: 'Hoje',
  history: 'Histórico',
  account: 'Conta',
  preferences: 'Preferências',
  language: 'Idioma',
  currency: 'Moeda',
  'odds format': 'Formato das odds',
  'time zone': 'Fuso horário',
  'my sportsbooks': 'Minhas casas de apostas',
  'responsible gambling': 'Jogo responsável',
  'add sportsbook': 'Adicionar casa',
  '+ add sportsbook': '+ Adicionar casa',
  'add your first sportsbook': 'Adicione sua primeira casa',
  'the catalogue has': 'O catálogo tem',
  'pick the ones you use and the capture dropdown shows only those.':
    'Selecione as casas que você usa; elas aparecerão no menu de captura.',
  'pick the ones you use and the capture dropdown shows only those':
    'Selecione as casas que você usa; elas aparecerão no menu de captura.',
  'your bet history stays yours. add the books you use to get started.':
    'Seu histórico continua seu. Adicione as casas que você usa para começar.',
  'add your first sportsbook in settings': 'Adicione sua primeira casa nas configurações',
  "my book isn't here": 'Minha casa não está aqui',
  'see all': 'Ver todas',
  'show less': 'Mostrar menos',
  'show all': 'Mostrar tudo',
  'more details': 'Mais detalhes',
  'date and number formatting · full translation is not available yet':
    'Formatação de datas e números · tradução completa da interface ainda não está disponível.',
  'date and number formatting': 'Formatação de datas e números',
  'full interface translation': 'Tradução parcial dos textos conhecidos da interface',
  'full interface in português (brasil)': 'Textos conhecidos da interface em português (Brasil)',
  'full interface language': 'Idioma dos textos conhecidos da interface',
  'display conversion only · brl remains the accounting currency':
    'Apenas conversão visual; BRL continua sendo a moeda contábil.',
  'how they’re shown · entry accepts all three':
    'Como as odds são exibidas; o cadastro aceita os três formatos.',
  'decides where your day ends': 'Define quando termina o seu dia.',
  english: 'Inglês',
  español: 'Espanhol',
  'português (brasil)': 'Português (Brasil)',
  'decimal · 1.42 · 2.50': 'Decimal · 1,42 · 2,50',
  'fractional · 2/5 · 3/2': 'Fracionário · 2/5 · 3/2',
  'american · −250 · +150': 'Americano · −250 · +150',
  'review or set your daily limit': 'Revise ou defina seu limite diário',
  'the limit is configured from your bankroll and recalculates when your bankroll changes.':
    'O limite é configurado na banca e recalculado quando o saldo muda.',
  'how the app behaves with you': 'Como o aplicativo funciona para você',
  'daily limit': 'Limite diário',
  'bettrack does not place bets if it feels like it got away from you':
    'O StakeFrame não faz apostas. Se sentir que perdeu o controle, faça uma pausa e converse com alguém de confiança.',
  'stakeframe does not place bets if it feels like it got away from you':
    'O StakeFrame não faz apostas. Se sentir que perdeu o controle, faça uma pausa e converse com alguém de confiança.',
  'stakeframe does not place bets': 'O StakeFrame não faz apostas',
  'if it feels like it got away from you': 'Se sentir que perdeu o controle',
  'take a pause and talk to someone you trust.':
    'Faça uma pausa e converse com alguém de confiança.',
  'for confidential help, contact a gambling support service in your country. support availability and phone numbers vary by location.':
    'Para obter ajuda confidencial, procure um serviço de apoio a jogadores no seu país. A disponibilidade e os telefones variam por região.',
  'your bets are yours. the file has one row per bet, with amounts, odds and results.':
    'Suas apostas são suas. O arquivo tem uma linha por aposta, com valores, odds e resultados.',
  'download my bets as csv': 'Baixar minhas apostas em CSV',
  'stakeframe workspace settings': 'Configurações do espaço Stakeframe',
  'catalog · units · telegram': 'Catálogo · unidades · Telegram',
  'book. pick the ones you use and the capture dropdown shows only those.':
    'Casa. Selecione as casas que você usa; elas aparecerão no menu de captura.',
  'books. pick the ones you use and the capture dropdown shows only those.':
    'Casas. Selecione as casas que você usa; elas aparecerão no menu de captura.',
  'open bankroll': 'Abrir banca',
  alerts: 'Alertas',
  'your bets stay in your control': 'Você mantém o controle das apostas',
  'this workspace records bets and results. it does not place bets, hold funds, or block a sportsbook account.':
    'Este espaço registra apostas e resultados. Ele não faz apostas, não guarda dinheiro e não bloqueia contas em casas.',
  'dashboard display options': 'Opções de exibição do painel',
  'show amounts': 'Mostrar valores',
  'hide amounts': 'Ocultar valores',
  'show in money or units': 'Exibir em dinheiro ou unidades',
  'show amounts in currency or units': 'Exibir valores em moeda ou unidades',
  'activity timeline': 'Linha do tempo de atividade',
  'days around the selected date': 'Dias ao redor da data selecionada',
  'previous day': 'Dia anterior',
  'next day': 'Próximo dia',
  'what bankroll means': 'O que significa banca',
  'the money available across your reserve and sportsbook accounts.':
    'O dinheiro disponível entre sua reserva e suas contas nas casas.',
  '1 unit': '1 unidade',
  'of bankroll': 'da banca',
  'no unit set': 'Nenhuma unidade definida',
  'outside 1–3%': 'Fora da faixa de 1–3%',
  'within 1–3%': 'Dentro da faixa de 1–3%',
  'at stake now': 'Em jogo agora',
  'what at stake now means': 'O que significa em jogo agora',
  'the real amount committed to open bets, before any result is known.':
    'O valor comprometido em apostas abertas, antes de qualquer resultado.',
  'if everything lands': 'Se tudo der certo',
  'the day': 'O dia',
  'what the day means': 'O que significa o dia',
  'settled result for the date selected on the activity timeline.':
    'Resultado liquidado na data selecionada na linha do tempo.',
  'result for the day': 'Resultado do dia',
  'nothing settled': 'Nada liquidado',
  'no cap set': 'Limite não definido',
  'set one': 'Definir limite',
  'running result': 'Resultado acumulado',
  'what running result means': 'O que significa resultado acumulado',
  'the cumulative result of settled bets by event date.':
    'Resultado acumulado das apostas liquidadas por data do evento.',
  'at your best point': 'No seu melhor momento',
  insights: 'Insights',
  'unit out of range': 'Unidade fora da faixa',
  '0 of 14 days in the red': '0 de 14 dias no negativo',
  'last 14 days': 'Últimos 14 dias',
  'when healthy is 1–3%': 'a faixa saudável é de 1–3%',
  days: 'dias',
  underwater: 'em recuperação',
  'days underwater': 'dias em recuperação',
  'worst drawdown': 'Pior queda',
  'of your bets, below': 'das suas apostas, no prejuízo',
  ceiling: 'Teto',
  'loading results': 'Carregando resultados',
  'view all': 'Ver todas',
  'to settle': 'para liquidar',
  'no bets that day': 'Nenhuma aposta nesse dia',
  'no bets': 'Sem apostas',
  'change breakdown': 'Alterar divisão',
  'today · by sport': 'Hoje · por esporte',
  'once there are bets on this date, this shows how the stake splits by type or sport.':
    'Quando houver apostas nesta data, veja aqui a divisão dos valores por tipo ou esporte.',
  breakdown: 'Divisão',
  'by sport': 'Por esporte',
  'log one': 'Registrar aposta',
  "today's bets": 'Apostas de hoje',
  'today’s bets': 'Apostas de hoje',
  'summary of today’s bets': 'Resumo das apostas de hoje',
  "summary of today's bets": 'Resumo das apostas de hoje',
  'resumen de apuestas de hoy': 'Resumo das apostas de hoje',
  'bets scheduled for today will show here, with their status and result. earlier bets appear in history.':
    'As apostas programadas para hoje aparecerão aqui, com status e resultado. As anteriores ficam no histórico.',
  'log the first one': 'Registrar a primeira aposta',
  amount: 'Valor',
  'newest or highest first': 'Mais recente ou maior primeiro',
  'sort descending': 'Ordenar em ordem decrescente',
  'weekly net · 2 weeks': 'Saldo semanal · 2 semanas',
  'in the red': 'no negativo',
  units: 'unidades',
  'try again': 'Tentar novamente',
  'open detailed analytics': 'Abrir análise detalhada',
  'back to analytics overview': 'Voltar à visão geral de análises',
  'units unavailable': 'Unidades indisponíveis',
  "couldn't load your analytics report.": 'Não foi possível carregar o relatório de análises.',
  "couldn't load analytics indicators.": 'Não foi possível carregar os indicadores de análises.',
  "couldn't load weekly results.": 'Não foi possível carregar os resultados semanais.',
  "couldn't load daily limit details.": 'Não foi possível carregar os detalhes do limite diário.',
  "couldn't load sports.": 'Não foi possível carregar os esportes.',
  "couldn't load the report.": 'Não foi possível carregar o relatório.',
  "couldn't load report details.": 'Não foi possível carregar os detalhes do relatório.',
  "couldn't load dimension comparisons.": 'Não foi possível carregar as comparações por dimensão.',
  'could not load the result.': 'Não foi possível carregar o resultado.',
  'could not load weekly results.': 'Não foi possível carregar os resultados semanais.',
  'loading weekly results…': 'Carregando resultados semanais…',
  'units are not available for some bets in this period.':
    'As unidades não estão disponíveis para algumas apostas deste período.',
  net: 'Saldo',
  yield: 'Retorno',
  'profit factor': 'Fator de lucro',
  'hit rate': 'Taxa de acerto',
  'per unit risked': 'Por unidade arriscada',
  'not enough settled results': 'Resultados liquidados insuficientes',
  'you win for every 1 you lose': 'Valor ganho para cada 1 perdido',
  'not the metric': 'Não é a métrica principal',
  'it’s too early to tell whether you’re winning': 'Ainda é cedo para saber se você está no lucro',
  "it's too early to tell whether you're winning": 'Ainda é cedo para saber se você está no lucro',
  'there is a hint, not a conclusion': 'Há um indício, ainda sem conclusão',
  'a trend is taking shape': 'Uma tendência está surgindo',
  'enough data to compare sports': 'Dados suficientes para comparar esportes',
  'the money is real. the conclusion isn’t.': 'O dinheiro é real. A conclusão ainda não.',
  "the money is real. the conclusion isn't.": 'O dinheiro é real. A conclusão ainda não.',
  'a hint is not a conclusion.': 'Um indício não é uma conclusão.',
  'a trend is not a promise.': 'Uma tendência não é uma promessa.',
  "you won or lost real money and it's in your bankroll. but at":
    'Você ganhou ou perdeu dinheiro de verdade, e isso aparece na sua banca. Mas com',
  'bets, the result is almost all chance: the same number comes from someone with a method and from someone lucky.':
    'apostas, o resultado ainda depende muito da sorte: o mesmo número pode vir de alguém com método ou de alguém com sorte.',
  'you’re here': 'Você está aqui',
  'too early': 'Cedo demais',
  'a hint': 'Um indício',
  'a trend': 'Uma tendência',
  'per sport': 'Por esporte',
  "you're here": 'Você está aqui',
  'nothing to go on yet': 'Ainda não há dados suficientes',
  'by dimension': 'Por dimensão',
  'yield per segment is missing on purpose: at these volumes it would be a number that looks like a finding and isn’t. only the count goes here.':
    'O retorno por segmento fica oculto com poucas apostas para evitar conclusões enganosas. Aqui mostramos apenas a quantidade.',
  'yield per segment stays hidden at low volumes. only the count goes here.':
    'O retorno por segmento fica oculto com poucas apostas. Aqui mostramos apenas a quantidade.',
  'compare by': 'Comparar por',
  sport: 'Esporte',
  book: 'Casa',
  roi: 'ROI',
  'more before this row says anything': 'a mais para esta linha ter relevância',
  'football / soccer': 'Futebol',
  'basketball / nba': 'Basquete / NBA',
  'market can’t be segmented yet · needs structure from extraction':
    'Mercado ainda sem segmento · falta estruturar os dados capturados',
  "market can't be segmented yet · needs structure from extraction":
    'Mercado ainda sem segmento · falta estruturar os dados capturados',
  'no settled bets in this segment yet': 'Ainda não há apostas liquidadas neste segmento',
  'no settled bets yet': 'Ainda não há apostas liquidadas',
  'your first records': 'Seus primeiros recordes',
  'records and consistency, worked out from your own bets. they look backwards on purpose.':
    'Recordes e consistência calculados a partir das suas apostas. Eles mostram o que já aconteceu.',
  'best day': 'Melhor dia',
  'longest winning streak': 'Maior sequência de vitórias',
  'bets logged': 'Apostas registradas',
  'logging is what makes the rest possible': 'Registrar é o que torna o restante possível',
  'your behaviour can already be seen': 'Seu comportamento já pode ser observado',
  'counting needs no sample; inferring does. facts appear from the first bet.':
    'Contar não exige amostra; tirar conclusões, sim. Os fatos aparecem desde a primeira aposta.',
  'fact · needs no sample': 'Fato · não exige amostra',
  of: 'de',
  'a record, not where you are now': 'um recorde, não sua situação atual',
  'of 20 losses': 'de 20 perdas',
  'of 9 bets fit in 1–3 u': 'de 9 apostas estão entre 1 e 3 unidades',
  'wins in a row , and that’s expected': 'vitórias seguidas, dentro do esperado',
  "wins in a row , and that's expected": 'vitórias seguidas, dentro do esperado',
  'and that’s expected': 'dentro do esperado',
  "and that's expected": 'dentro do esperado',
  'bets fit in 1–3 u': 'apostas entre 1 e 3 unidades',
  'settled bets · since': 'apostas liquidadas · desde',
  'no limit set': 'Limite não definido',
  "you haven't set a daily limit": 'Você ainda não definiu um limite diário',
  'a limit is configured from bankroll and recalculates when your bankroll changes.':
    'O limite é configurado na banca e recalculado quando o saldo muda.',
  'can’t be read yet': 'Ainda não é possível avaliar',
  "can't be read yet": 'Ainda não é possível avaliar',
  'whether you raise your stake after losing': 'Se você aumenta o valor após perder',
  'streak · no reading': 'sequência · sem conclusão',
  'wins in a row, and that’s expected': 'vitórias seguidas, dentro do esperado',
  "wins in a row, and that's expected": 'vitórias seguidas, dentro do esperado',
  'a streak is not a measure of skill.': 'Uma sequência não mede habilidade.',
  'parlays · data': 'Múltiplas · dados',
  'their performance can be compared when enough settled tickets are available.':
    'O desempenho pode ser comparado quando houver bilhetes liquidados suficientes.',
  'export csv': 'Exportar CSV',
  'export csv ↓': 'Exportar CSV ↓',
  since: 'Desde',
  'settled bets': 'apostas liquidadas',
  'baseball / mlb': 'Beisebol / MLB',
  'the pattern that costs the most money, and seeing it needs at least':
    'Esse padrão pode custar caro e só pode ser avaliado após pelo menos',
  "it's the pattern that costs the most money, and seeing it needs at least":
    'Esse padrão pode custar caro e só pode ser avaliado após pelo menos',
  "settled losses. you're at": 'perdas liquidadas. Até agora, você tem',
  "we won't say you do it: the data can't tell us yet.":
    'Não vamos afirmar que isso acontece: os dados ainda não permitem concluir.',
  at: 'Em',
  'bets, a run of up to': 'apostas, uma sequência de até',
  'either way is normal. a streak is not a measure of skill.':
    'para qualquer lado é normal. Uma sequência não mede habilidade.',
  'wins in a row': 'vitórias seguidas',
  'is expected': 'é esperado',
  'of what you risk goes on parlays': 'do valor arriscado vai para apostas múltiplas',
  'at risk': 'Em risco',
  'day’s net': 'Saldo do dia',
  'no bets for today yet': 'Nenhuma aposta para hoje',
  'today · 1 open · loading results': 'Hoje · 1 aposta aberta · carregando resultados',
  all: 'Todas',
  won: 'Ganha',
  lost: 'Perdida',
  void: 'Anulada',
  'cash out': 'Resgate antecipado',
  'sort history by': 'Ordenar histórico por',
  'filter history by result': 'Filtrar histórico por resultado',
  date: 'Data',
  selection: 'Seleção',
  odds: 'Odds',
  status: 'Status',
  result: 'Resultado',
  'date / time': 'Data / hora',
  bookmaker: 'Casa de apostas',
  'sport / league': 'Esporte / liga',
  'bet type': 'Tipo de aposta',
  'market type': 'Tipo de mercado',
  'ticket type': 'Tipo de bilhete',
  'all bookmakers': 'Todas as casas',
  'all sports': 'Todos os esportes',
  'all bet types': 'Todos os tipos de aposta',
  'all types': 'Todos os tipos',
  'all tipsters': 'Todos os tipsters',
  from: 'De',
  to: 'Até',
  columns: 'Colunas',
  'filtered period': 'Período filtrado',
  'net result': 'Resultado líquido',
  settled: 'Liquidadas',
  'search bet history': 'Buscar no histórico de apostas',
  'apply filters': 'Aplicar filtros',
  'clear filters': 'Limpar filtros',
  'remove search filter': 'Remover filtro de busca',
  'summary for the filtered period': 'Resumo do período filtrado',
  'bet history table': 'Tabela do histórico de apostas',
  'bet sections': 'Seções de apostas',
  'main navigation': 'Navegação principal',
  'open navigation': 'Abrir navegação',
  'close navigation': 'Fechar navegação',
  'choose visible history columns': 'Escolher colunas visíveis do histórico',
  'choose which fields appear in the history table.':
    'Escolha quais campos aparecem na tabela do histórico.',
  'reset columns': 'Redefinir colunas',
  pinned: 'Fixas',
  'the history table is wider than the screen. scroll horizontally to see every visible column.':
    'A tabela do histórico é mais larga que a tela. Role horizontalmente para ver todas as colunas visíveis.',
  paid: 'Pago',
  'to win': 'Retorno potencial',
  open: 'Aberta',
  'open bets': 'apostas abertas',
  'no book': 'Sem casa',
  selections: 'Seleções',
  '2 selections': '2 seleções',
  'show the 2 selections': 'Mostrar as 2 seleções',
  'parlay · 2 legs': 'Múltipla · 2 seleções',
  '2-leg multi-sport parlay': 'Múltipla multiesportiva de 2 seleções',
  'settle this bet': 'Liquidar aposta',
  pays: 'Retorna',
  'you lose the amount': 'Você perde o valor',
  'returns the full amount': 'Devolve o valor integral',
  'asks what you took out': 'Informe quanto recebeu',
  'amount received (r$)': 'Valor recebido (R$)',
  cancel: 'Cancelar',
  'saving…': 'Salvando…',
  'confirm cash out': 'Confirmar resgate',
  'hedge this bet': 'Fazer hedge desta aposta',
  'potential profit': 'Lucro potencial',
  record: 'Registro',
  'pick tipsters…': 'Selecione tipsters…',
  sportsbook: 'Casa de apostas',
  logged: 'Registrada em',
  'share bet': 'Compartilhar aposta',
  'edit bet': 'Editar aposta',
  'delete bet': 'Excluir aposta',
  straight: 'Simples',
  parlay: 'Múltipla',
  'step 1 of 3 · bet type': 'Etapa 1 de 3 · tipo de aposta',
  'hedge a bet': 'Proteger uma aposta',
  'step 1 of 3 · where we start': 'Etapa 1 de 3 · ponto de partida',
  'step 2 of 3 · the other odds': 'Etapa 2 de 3 · odds do outro lado',
  'step 3 of 3 · the decision': 'Etapa 3 de 3 · decisão',
  'where we start': 'Ponto de partida',
  start: 'Início',
  decide: 'Decisão',
  'hedge calculator steps': 'Etapas da calculadora de proteção',
  'what are we calculating on?': 'O que vamos calcular?',
  'you can start from a bet you already logged, or just run the numbers without logging anything.':
    'Você pode usar uma aposta já registrada ou fazer o cálculo sem salvar nada.',
  'one of my bets': 'Uma das minhas apostas',
  "it brings the bet's odds and amount, and at the end it can log the hedge next to it.":
    'Traz as odds e o valor da aposta e, no final, permite registrar a proteção junto dela.',
  'numbers only': 'Somente números',
  'logs nothing': 'Não registra nada',
  "you type the odds and amount by hand. good for testing the water before betting, or for a bet that isn't in the app.":
    'Você informa as odds e o valor manualmente. Serve para simular antes de apostar ou calcular uma aposta que não está no aplicativo.',
  'pick which one': 'Escolha uma aposta',
  'no open bets yet. use numbers only to calculate by hand.':
    'Ainda não há apostas abertas. Use “Somente números” para fazer o cálculo manualmente.',
  'your odds': 'Suas odds',
  'what are the odds on the other side?': 'Quais são as odds do outro lado?',
  'enter the decimal odds for the opposite outcome.':
    'Informe as odds decimais do resultado oposto.',
  'opposite odds': 'Odds do outro lado',
  'use odds above 1.00 and an amount above zero.':
    'Informe odds acima de 1,00 e um valor maior que zero.',
  'the two sides together': 'Os dois lados juntos',
  'hedging leaves you': 'A proteção garante',
  'hedging costs you': 'A proteção custa',
  guaranteed: 'garantidos',
  stake: 'Valor apostado',
  'on the opposite side. the estimate uses the odds and amount you entered.':
    'no outro lado. A estimativa usa as odds e o valor informados.',
  'hedge stake': 'Valor da proteção',
  'guaranteed result': 'Resultado garantido',
  'log the hedge': 'Registrar proteção',
  "the one you're hedging": 'A aposta que você está protegendo',
  'choose an open bet': 'Escolha uma aposta aberta',
  'your selection': 'Sua seleção',
  'your logged ticket': 'Seu bilhete registrado',
  'if it wins alone': 'Se vencer sozinha',
  continue: 'Continuar',
  manual: 'Manual',
  '+ new bet': '+ Nova aposta',
  '＋ new bet': '+ Nova aposta',
  'what are you logging?': 'O que você quer registrar?',
  'one selection, one price.': 'Uma seleção e uma odd.',
  'two or more selections on the same ticket.': 'Duas ou mais seleções no mesmo bilhete.',
  'analyse your betslip with bettrack ai': 'Analise seu bilhete com a IA do BetTrack',
  'coming soon': 'Em breve',
  'bet details': 'Detalhes da aposta',
  'sport, event, your selection, odds and date.': 'Esporte, evento, seleção, odds e data.',
  'add selection': 'Adicionar seleção',
  event: 'Evento',
  'event date': 'Data do evento',
  confirm: 'Confirmar',
  save: 'Salvar',
  close: 'Fechar',
  back: 'Voltar',
  next: 'Avançar',
  delete: 'Excluir',
  edit: 'Editar',
  share: 'Compartilhar',
  filter: 'Filtrar',
  search: 'Buscar',
  clear: 'Limpar',
  'loading…': 'Carregando…',
  'no results': 'Nenhum resultado',
  yesterday: 'Ontem',
};

const normalized = (value: string) => value.replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
const originalText = new WeakMap<Text, { source: string; last: string }>();
const originalAttributes = new WeakMap<Element, Map<string, { source: string; last: string }>>();

function translateValue(value: string, language: string) {
  if (language !== 'pt-BR') return value;
  const leading = value.match(/^\s*/)?.[0] ?? '';
  const trailing = value.match(/\s*$/)?.[0] ?? '';
  const source = value.trim();
  const compact = source.replace(/\s+/g, ' ');
  const key = normalized(source);
  const wrap = (translated: string) => `${leading}${translated}${trailing}`;
  const settledSince = compact.match(/^(\d+) SETTLED BETS?\s*·\s*SINCE\s+(.+)$/i);
  if (settledSince) return wrap(`${settledSince[1]} apostas liquidadas · desde ${settledSince[2]}`);
  const hitRateSummary = compact.match(/^(\d+)\s+OF\s+(\d+)\s+·\s+NOT THE METRIC$/i);
  if (hitRateSummary)
    return wrap(`${hitRateSummary[1]} de ${hitRateSummary[2]} · não é a métrica principal`);
  const sample = compact.match(/^(\d+)\s+OF\s+(\d+)\s+BETS FIT IN 1–3 U$/i);
  if (sample) return wrap(`${sample[1]} de ${sample[2]} apostas estão entre 1 e 3 unidades`);
  const losses = compact.match(/^(\d+)\s+OF\s+(\d+)\s+LOSSES STREAK\s*·\s*NO READING$/i);
  if (losses) return wrap(`${losses[1]} de ${losses[2]} perdas · sem conclusão`);
  const streak = compact.match(/^(\d+) WINS IN A ROW\s*,\s*AND THAT(?:’|'|\u2019)S EXPECTED$/i);
  if (streak) return wrap(`${streak[1]} vitórias seguidas, dentro do esperado`);
  const parlays = compact.match(/^(\d+(?:\.\d+)?)\s*% OF WHAT YOU RISK GOES ON PARLAYS$/i);
  if (parlays)
    return wrap(`${parlays[1]!.replace('.', ',')}% do valor arriscado vai para apostas múltiplas`);
  const weeklyA11y = compact.match(/^Weekly net in units:\s*(.+)$/i);
  if (weeklyA11y)
    return wrap(
      `Saldo semanal em unidades: ${weeklyA11y[1]!.replace(/units unavailable/gi, 'unidades indisponíveis')}`,
    );
  const runningA11y = compact.match(
    /^Running result this month\. Ends at (.+) across (\d+) settled bets\.?$/i,
  );
  if (runningA11y)
    return wrap(
      `Resultado acumulado neste mês. Termina em ${runningA11y[1]} ao longo de ${runningA11y[2]} apostas liquidadas.`,
    );
  const settleCount = compact.match(/^(\d+) TO SETTLE$/i);
  if (settleCount) return wrap(`${settleCount[1]} para liquidar`);
  const sampleA11y = compact.match(/^(\d+) settled bets\. (.+)$/i);
  if (sampleA11y) {
    const level = ptBR[normalized(sampleA11y[2]!)] ?? sampleA11y[2]!;
    return wrap(`${sampleA11y[1]} apostas liquidadas. ${level}`);
  }
  const exact = ptBR[key];
  if (exact) return wrap(exact);
  let embedded = source
    .replace(/you['’]re here/gi, 'Você está aqui')
    .replace(/\bno bets\b/gi, 'sem apostas')
    .replace(/\bby sport\b/gi, 'por esporte');
  const longPhrases = Object.entries(ptBR)
    .filter(([english]) => english.length >= 12)
    .sort(([a], [b]) => b.length - a.length);
  for (const [english, portuguese] of longPhrases) {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    embedded = embedded.replace(new RegExp(escaped, 'gi'), portuguese);
  }
  if (embedded !== source) return wrap(embedded);
  const catalogue = source.match(
    /^THE CATALOGUE HAS\s+(\d+)\s+BOOKS?\.?\s*PICK THE ONES YOU USE AND THE CAPTURE DROPDOWN SHOWS ONLY THOSE\.?$/i,
  );
  if (catalogue)
    return wrap(
      `O catálogo tem ${catalogue[1]} ${catalogue[1] === '1' ? 'casa' : 'casas'}. Selecione as casas que você usa; elas aparecerão no menu de captura.`,
    );
  const seeAll = compact.match(/^SEE ALL (\d+)$/i);
  if (seeAll) return wrap(`VER TODAS ${seeAll[1]}`);
  const count = compact.match(/^(\d+) (?:MORE )?BEFORE THIS ROW SAYS ANYTHING$/i);
  if (count) return wrap(`${count[1]} A MAIS PARA ESTA LINHA TER RELEVÂNCIA`);
  const openBets = compact.match(/^(\d+) OPEN(?: BETS?)?$/i);
  if (openBets)
    return wrap(`${openBets[1]} ${openBets[1] === '1' ? 'APOSTA ABERTA' : 'APOSTAS ABERTAS'}`);
  const bankrollPercent = compact.match(/^(\d+(?:\.\d+)?)% OF BANKROLL$/i);
  if (bankrollPercent) return wrap(`${bankrollPercent[1]!.replace('.', ',')}% DA BANCA`);
  const underwater = compact.match(/^(\d+) DAYS?\s+UNDERWATER$/i);
  if (underwater)
    return wrap(
      `${underwater[1]} ${underwater[1] === '1' ? 'DIA EM RECUPERAÇÃO' : 'DIAS EM RECUPERAÇÃO'}`,
    );
  const below = compact.match(/^(\d+(?:\.\d+)?)% OF YOUR BETS, BELOW$/i);
  if (below) return wrap(`${below[1]!.replace('.', ',')}% DAS SUAS APOSTAS NO PREJUÍZO`);
  const betCount = compact.match(/^(\d+) BETS?$/i);
  if (betCount) return wrap(`${betCount[1]} ${betCount[1] === '1' ? 'APOSTA' : 'APOSTAS'}`);
  if (/PICK THE ONES YOU USE AND THE CAPTURE DROPDOWN SHOWS ONLY THOSE/i.test(source)) {
    return wrap(
      source.replace(
        /PICK THE ONES YOU USE AND THE CAPTURE DROPDOWN SHOWS ONLY THOSE\.?/i,
        'Selecione as casas que você usa; elas aparecerão no menu de captura.',
      ),
    );
  }
  const catalogueStart = source.match(/^THE CATALOGUE HAS (\d+) BOOKS?\.?$/i);
  if (catalogueStart)
    return wrap(
      `O catálogo tem ${catalogueStart[1]} ${catalogueStart[1] === '1' ? 'casa' : 'casas'}`,
    );
  return value;
}

function translateNode(node: Node, language: string) {
  const translateText = (textNode: Text) => {
    let state = originalText.get(textNode);
    const current = textNode.nodeValue ?? '';
    if (!state || current !== state.last) state = { source: current, last: current };
    const translated = translateValue(state.source, language);
    state.last = translated;
    originalText.set(textNode, state);
    if (translated !== current) textNode.nodeValue = translated;
  };
  if (node.nodeType === Node.TEXT_NODE) {
    translateText(node as Text);
    return;
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode();
  while (text) {
    const parent = text.parentElement;
    if (parent && !parent.closest('script,style,[data-no-translate]')) {
      translateText(text as Text);
    }
    text = walker.nextNode();
  }
  const elements = node instanceof Element ? [node, ...node.querySelectorAll('*')] : [];
  for (const element of elements) {
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      const value = element.getAttribute(attribute);
      if (value) {
        let states = originalAttributes.get(element);
        if (!states) {
          states = new Map();
          originalAttributes.set(element, states);
        }
        let state = states.get(attribute);
        if (!state || value !== state.last) state = { source: value, last: value };
        const translated = translateValue(state.source, language);
        state.last = translated;
        states.set(attribute, state);
        if (translated !== value) element.setAttribute(attribute, translated);
      }
    }
  }
}

/** Translate interface labels as React mounts and updates the current route. */
export function observeUiLanguage(root: HTMLElement) {
  let language = readDisplayPreferences().language;
  const translate = () => {
    language = readDisplayPreferences().language;
    document.documentElement.lang = language;
    translateNode(root, language);
  };
  translate();
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData' && record.target.parentElement) {
        translateNode(record.target.parentElement, language);
      } else {
        for (const node of record.addedNodes) translateNode(node, language);
        if (record.type === 'attributes' && record.target instanceof Element)
          translateNode(record.target, language);
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['aria-label', 'title', 'placeholder'],
  });
  window.addEventListener('bettrack:preferences', translate);
  return () => {
    observer.disconnect();
    window.removeEventListener('bettrack:preferences', translate);
  };
}
