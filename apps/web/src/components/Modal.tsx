import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';

const focusableSelector = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

export function Modal({ title, children, onClose, dismissible = true }: { title: string; children: ReactNode; onClose: () => void; dismissible?: boolean }) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const dismissibleRef = useRef(dismissible);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
    if (!dismissible && document.activeElement === closeButtonRef.current) {
      dialogRef.current?.focus();
    }
  }, [dismissible, onClose]);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dismissibleRef.current) closeButtonRef.current?.focus();
    else dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (dialog === null) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      restoreFocusRef.current?.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={() => {
      if (dismissibleRef.current) onCloseRef.current();
    }}>
      <section ref={dialogRef} tabIndex={-1} className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        <header><h2 id={titleId}>{title}</h2><button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭" disabled={!dismissible} onClick={onClose}>×</button></header>
        {children}
      </section>
    </div>
  );
}
