import { useEffect, useRef, useState } from 'react';
import { Button } from '../components/ui/button.js';
import {
  ALL_BET_COLUMNS,
  DEFAULT_BET_COLUMNS,
  REQUIRED_BET_COLUMNS,
  readBetColumns,
  writeBetColumns,
  type BetTableColumnKey,
} from './bet-columns.js';

/**
 * STK-F2-18 (Fase 3) — painel de colunas da tabela de apostas.
 *
 * A tabela tem 14 colunas aprovadas pelo proprietário e 1640px de largura
 * mínima. Este painel é o que torna a tabela usável: a pessoa escolhe quais
 * colunas quer, a ordem continua sendo a aprovada, e a preferência persiste.
 *
 * Decisões de interface que valem registrar:
 *
 * - É um `popover` ancorado no botão, fechado por Escape, clique fora e
 *   Tab para fora. Foco preso NÃO: quem abre o painel ainda precisa
 *   alcançar os filtros da tabela logo abaixo dele. Isso é o oposto de um
 *   diálogo, e é por isso que não é um diálogo.
 * - Aplicação imediata, sem botão "Salvar". Preferência de leitura que
 *   exige confirmação obriga a pessoa a lembrar de confirmar.
 * - `aria-expanded` + um único ponto de saída por teclado. O painel não é
 *   menu (não é uma lista de ações) e não é diálogo: é um grupo de
 *   checkboxes, e cada checkbox é o seu próprio alvo de toque.
 */
export function BetColumnsPanel({
  owner,
  columns,
  onChange,
}: {
  owner: string;
  columns: readonly BetTableColumnKey[];
  onChange: (columns: BetTableColumnKey[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [open]);

  const visible = new Set(columns);
  const toggle = (key: BetTableColumnKey) => {
    const next = visible.has(key)
      ? columns.filter((column) => column !== key)
      : // Reinsere na ordem aprovada do catálogo, não na ordem do clique.
        ALL_BET_COLUMNS.map((column) => column.key).filter(
          (column) => visible.has(column) || column === key,
        );
    writeBetColumns(owner, next, typeof window === 'undefined' ? null : window.localStorage);
    onChange(next);
  };
  const hidden = ALL_BET_COLUMNS.length - columns.length;

  return (
    <div className="columns-panel" ref={container}>
      <Button
        variant="secondary"
        size="small"
        ref={trigger}
        aria-expanded={open}
        aria-controls="bet-columns-options"
        onClick={() => setOpen((value) => !value)}
      >
        Colunas
        <span className="columns-panel-count">
          {columns.length}/{ALL_BET_COLUMNS.length}
        </span>
      </Button>
      {open ? (
        <div
          className="columns-panel-popover"
          id="bet-columns-options"
          role="group"
          aria-label="Escolher colunas da tabela"
        >
          <p className="columns-panel-title">Colunas da tabela</p>
          <p className="columns-panel-hint">
            A ordem é sempre a do produto. Você escolhe quais aparecem.
          </p>
          <ul className="columns-panel-list">
            {ALL_BET_COLUMNS.map((column) => {
              const required = REQUIRED_BET_COLUMNS.includes(column.key);
              const checked = visible.has(column.key);
              return (
                <li key={column.key}>
                  <label
                    className={required ? 'columns-panel-item is-required' : 'columns-panel-item'}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={required}
                      onChange={() => toggle(column.key)}
                    />
                    <span>{column.label}</span>
                    {required ? (
                      <span
                        className="columns-panel-required"
                        title="Esta coluna não pode ser escondida"
                      >
                        fixa
                      </span>
                    ) : null}
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="columns-panel-actions">
            <Button
              variant="ghost"
              size="small"
              onClick={() => {
                const next = [...DEFAULT_BET_COLUMNS];
                writeBetColumns(
                  owner,
                  next,
                  typeof window === 'undefined' ? null : window.localStorage,
                );
                onChange(next);
              }}
              disabled={columns.length === DEFAULT_BET_COLUMNS.length}
            >
              Voltar ao padrão
            </Button>
          </div>
          {hidden > 0 ? (
            <p className="columns-panel-hint">
              {hidden} {hidden === 1 ? 'coluna escondida' : 'colunas escondidas'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Lê a preferência preferindo o browser; SSR/testes caem no padrão. */
export function loadBetColumns(owner: string): BetTableColumnKey[] {
  return readBetColumns(owner, typeof window === 'undefined' ? null : window.localStorage);
}
