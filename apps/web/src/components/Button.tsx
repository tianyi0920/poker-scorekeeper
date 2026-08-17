import type { ButtonHTMLAttributes } from 'react';
import { useOnlineStatus } from '../hooks/useOnlineStatus.js';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  unsafe?: boolean;
}

export function Button({ variant = 'primary', unsafe = false, disabled, className = '', type = 'button', ...props }: ButtonProps) {
  const online = useOnlineStatus();
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || (unsafe && !online)}
      className={`button button--${variant} ${className}`.trim()}
    />
  );
}
