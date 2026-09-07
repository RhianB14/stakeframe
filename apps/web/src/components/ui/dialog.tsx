import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';

// Composition follows shadcn/ui's Radix dialog, styled to the project's visual tokens.
export function Dialog({
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
        <DialogPrimitive.Overlay className="dialog-overlay" />
        <DialogPrimitive.Content className="dialog-content">
          <div className="dialog-header">
            <div>
              <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description>{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">
                  Confira os dados antes de confirmar.
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close className="dialog-close" aria-label="Fechar janela">
              ×
            </DialogPrimitive.Close>
          </div>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
