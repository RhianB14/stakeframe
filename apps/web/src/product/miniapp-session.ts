/**
 * STK-F2-12 — sessão do Mini App no cliente.
 *
 * O Mini App NÃO tem uma segunda camada de produto: ele renderiza os mesmos
 * componentes da web responsiva (F2-01) e chama as mesmas rotas. A única coisa
 * que ele precisa acrescentar é o cabeçalho `x-telegram-init-data`, porque
 * dentro do cliente do Telegram não existe cookie de sessão.
 *
 * Em vez de duplicar cada chamada (`request(url, schema, { headers })`) nos
 * componentes reutilizados, a sessão fica aqui, em UM lugar, e `request()` a
 * aplica. Isso mantém uma única verdade também no cliente: trocar de tela não
 * pode esquecer o initData, e voltar para a web limpa o estado.
 *
 * O valor NUNCA é persistido (nada em localStorage/sessionStorage/cookie): o
 * initData é uma credencial de curta duração e o §6.2 rejeita estado offline.
 * Ele vive apenas na memória da aba, some ao fechá-la e é zerado em logout.
 *
 * Um único initData por vez, sem acúmulo: abrir duas sessões do Telegram na
 * mesma aba trocaria o token no meio de uma requisição em voo.
 */
let activeInitData: string | null = null;

/** Define (ou limpa, com `null`) a credencial da sessão Mini App da aba. */
export function setMiniAppInitData(initData: string | null): void {
  activeInitData = initData && initData.length > 0 ? initData : null;
}

/** A credencial ativa, ou `null` na web (onde o cookie basta). */
export function miniAppInitData(): string | null {
  return activeInitData;
}

/** Cabeçalhos extras da sessão atual — objeto vazio na web. */
export function miniAppHeaders(): Record<string, string> {
  return activeInitData ? { 'x-telegram-init-data': activeInitData } : {};
}
