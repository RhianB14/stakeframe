import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

/**
 * STK-F2-18 (Fase 3) — drawer lateral para o detalhe da aposta.
 *
 * O detalhe da aposta vivia num diálogo centralizado de 760px. Isso é
 * errado por uma razão concreta: o produto mostra a LISTA como contexto e o
 * DETALHE como resposta. Centralizado, o diálogo cobre metade das linhas que
 * a pessoa estava comparando, e para ler o detalhe de três apostas seguidas
 * ela fecha, rola, abre, três vezes.
 *
 * O drawer ancora à direita: a lista continua visível na esquerda, a coluna
 *money é a mesma nos dois lados, e o detalhe é lido ao lado do registro.
 *
 * É sobre `DialogPrimitive` por decisão, não por conveniência — herda de
 * graça o que é caro de acertar à mão: foco preso, `aria-modal`, bloqueio de
 * rolagem do fundo, Escape, devolução de foco ao gatilho e `pointer-events`
 * nos elementos externos. Reimplementar isso é a forma garantida de vazar
 * foco e quebrar o teclado.
 *
 * A diferença em relação ao `Dialog` centralizado é geometria e
 * comportamento de largura, não acessibilidade: as duas surfaces usam
 * `DialogPrimitive.Content`.
 */
export function BetDrawer({
  title,
  description,
  open,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="drawer-overlay" />
        <DialogPrimitive.Content className="drawer-content">
          <div className="drawer-header">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
              ) : (
                /* Descrição ausente é defeito de acessibilidade: sem ela o
                   leitor de tela anuncia o diálogo sem dizer do que ele trata.
                   O padrão é específico desta tela, não genérico. */
                <DialogPrimitive.Description className="sr-only">
                  Detalhe completo do bilhete, com evento, seleção, valores e resultado registrado.
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="drawer-close" aria-label="Fechar detalhe da aposta">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
                <path
                  d="M6 6l12 12M18 6L6 18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                />
              </svg>
            </DialogPrimitive.Close>
          </div>
          <div className="drawer-body">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
