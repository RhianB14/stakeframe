import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils.js';

const variants = cva('ui-button', {
  variants: {
    variant: {
      default: 'ui-button-primary',
      secondary: 'ui-button-secondary',
      ghost: 'ui-button-ghost',
      destructive: 'ui-button-destructive',
    },
    size: { default: '', small: 'ui-button-small' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});
export function Button({
  className,
  variant,
  size,
  type = 'button',
  ...props
}: ComponentProps<'button'> & VariantProps<typeof variants>) {
  return (
    <button
      data-slot="button"
      type={type}
      className={cn(variants({ variant, size }), className)}
      {...props}
    />
  );
}
