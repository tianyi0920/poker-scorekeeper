import { type ButtonHTMLAttributes, useEffect, useState } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  unsafe?: boolean;
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

export function Button({ variant = 'primary', unsafe = false, disabled, className = '', type = 'button', ...props }: ButtonProps) {
  const online = useOnline();
  return (
    <button
      {...props}
      type={type}
      disabled={disabled || (unsafe && !online)}
      className={`button button--${variant} ${className}`.trim()}
    />
  );
}
