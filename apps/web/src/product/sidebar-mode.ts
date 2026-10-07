/**
 * STK-F3-01 — o modo da sidebar e sua persistência.
 *
 * A sidebar tem TRÊS modos e não dois, e a diferença entre "Collapsed" e
 * "Expand on hover" é de INTENÇÃO, não de desenho: no segundo a largura
 * reservada continua sendo a do modo recolhido e a expansão acontece por
 * cima. Quem escolhe "hover" está dizendo que a largura da coluna não é
 * dele — quem trabalha na tabela o tempo todo precisa da área larga de
 * verdade, e uma sidebar que empurra o conteúdo a cada passagem do mouse
 * seria perda, não ganho.
 *
 * Por isso a assinatura expõe TRÊS medidas e não uma: a largura que
 * RESERVA espaço (`offset`) é diferente da largura que a sidebar TEM
 * (`width`) exatamente no modo hover. Um `width` só esconderia essa
 * diferença e faria o conteúdo saltar no hover — que é o defeito que o
 * card proíbe explicitamente.
 *
 * A chave de storage é versionada e o valor é validado na LEITURA, não
 * apenas na escrita: `localStorage` é do usuário, sobrevive a versões do
 * produto e pode ser editado à mão. Um valor desconhecido cai no padrão
 * (`expanded`) em vez de deixar a sidebar sem largura.
 */

export const SIDEBAR_MODES = ['expanded', 'collapsed', 'hover'] as const;
export type SidebarMode = (typeof SIDEBAR_MODES)[number];

export const SIDEBAR_MODE_STORAGE_KEY = 'stakeframe.sidebar-mode';

/**
 * STK-F3-01 — a LARGURA dos modos vive na folha: `--sidebar-w` em
 * `tokens.css` (208px) e o override do tema web em `product.css` (202px).
 *
 * O componente é dono da ESCOLHA do modo, não do número. A constante
 * `SIDEBAR_WIDTHS` que existia aqui não tinha nenhum importador e o
 * comentário prometia uma conferência do teste de tokens que não existia —
 * por isso ela saiu em vez de mentir sobre uma garantia.
 */

/**
 * Valida o valor GRAVADO. Isto roda na LEITURA, e não só na escrita: o
 * storage é do usuário, sobrevive a versões do produto e pode ser editado à
 * mão. Um valor desconhecido cai em `expanded` em vez de deixar a sidebar
 * sem largura.
 */
export function isSidebarMode(value: unknown): value is SidebarMode {
  return typeof value === 'string' && (SIDEBAR_MODES as readonly string[]).includes(value);
}

/**
 * Lê a preferência. `storage` chega nulo nos caminhos sem DOM (o mesmo
 * contrato de `bet-columns.ts`), e um storage ausente ou ilegível devolve
 * o padrão em vez de lançar — a sidebar não pode deixar de renderizar
 * porque uma preferência decorativa não foi lida.
 */
export function readSidebarMode(storage: Pick<Storage, 'getItem'> | null): SidebarMode {
  try {
    const stored = storage?.getItem(SIDEBAR_MODE_STORAGE_KEY);
    return isSidebarMode(stored) ? stored : 'expanded';
  } catch {
    return 'expanded';
  }
}

export function writeSidebarMode(
  storage: Pick<Storage, 'setItem'> | null,
  mode: SidebarMode,
): void {
  try {
    storage?.setItem(SIDEBAR_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage cheio ou bloqueado (aba anônima, cookies de terceiros negados)
    // é um estado legítimo do navegador: a preferência vale SÓ nesta
    // sessão, e a sidebar continua utilizável.
  }
}
