import { useEffect, useMemo, useRef, useState } from 'react';
import type { PickerOption } from './miniapp-options.js';

const normalized = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR');

export function MobilePicker({
  label,
  value,
  placeholder,
  options,
  searchable = false,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  options: PickerOption[];
  searchable?: boolean;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  const filtered = useMemo(() => {
    const needle = normalized(query.trim());
    if (!needle) return options;
    return options.filter((option) =>
      normalized(`${option.label} ${option.description ?? ''} ${option.value}`).includes(needle),
    );
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => searchRef.current?.focus(), 120);
    return () => {
      document.body.style.overflow = before;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="mini-picker-field">
      <span className="mini-field-label">{label}</span>
      <button
        type="button"
        className="mini-picker-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <span className={selected ? '' : 'mini-placeholder'}>
          {selected?.icon ? `${selected.icon} ` : ''}
          {selected?.label ?? placeholder}
        </span>
        <span aria-hidden="true">⌄</span>
      </button>
      {open ? (
        <div className="mini-sheet-layer" role="presentation" onMouseDown={() => setOpen(false)}>
          <div
            className="mini-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={label}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mini-sheet-handle" aria-hidden="true" />
            <div className="mini-sheet-heading">
              <h2>{label}</h2>
              <button type="button" aria-label="Fechar" onClick={() => setOpen(false)}>
                ×
              </button>
            </div>
            {searchable ? (
              <input
                ref={searchRef}
                className="mini-sheet-search"
                type="search"
                value={query}
                placeholder={`Pesquisar ${label.toLocaleLowerCase('pt-BR')}`}
                onChange={(event) => setQuery(event.target.value)}
              />
            ) : null}
            <div className="mini-sheet-options" role="listbox" aria-label={label}>
              {filtered.map((option) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={option.value === value ? 'selected' : ''}
                  key={option.value}
                  onClick={() => {
                    onChange(option.value);
                    setOpen(false);
                    setQuery('');
                  }}
                >
                  {option.icon ? <span className="mini-option-icon">{option.icon}</span> : null}
                  <span>
                    <strong>{option.label}</strong>
                    {option.description ? <small>{option.description}</small> : null}
                  </span>
                  {option.value === value ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))}
              {filtered.length === 0 ? (
                <p className="mini-empty">Nenhuma opção encontrada.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
