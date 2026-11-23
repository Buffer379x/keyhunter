import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button, Help } from './ui';

export * from './ui';
export { Brand } from './brand';
/** Page header (`.page-head`): the h1 with an optional help symbol, a sub line and actions on the right (they wrap below on narrow screens). */
export function PageHeading({ title, sub, help, actions, id }: { title: string; sub?: ReactNode; help?: ReactNode; actions?: ReactNode; id?: string }) {
  return (
    <header className="page-head">
      <div>
        <div className="page-title">
          <h1 id={id}>{title}</h1>
          {help && <Help label={`Hilfe zu ${title}`}>{help}</Help>}
        </div>
        {sub && <p>{sub}</p>}
      </div>
      {actions && <div className="head-actions">{actions}</div>}
    </header>
  );
}
export function Notice({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return (
    <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>
      {children}
    </div>
  );
}
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  cancelLabel = 'Abbrechen',
  busy = false,
  danger = false,
  onCancel,
  onConfirm,
  children,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Destructive action: the confirm button is styled as danger. */ danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onCancel={event => {
        event.preventDefault();
        event.stopPropagation();
        if (!busy) onCancel();
      }}
    >
      <h2 id={titleId}>{title}</h2>
      {children}
      <div className="dialog-actions">
        <Button disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={danger ? 'danger' : 'primary'} disabled={busy} onClick={onConfirm}>
          {busy ? 'Wird gespeichert …' : confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
