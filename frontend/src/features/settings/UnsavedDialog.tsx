import { useEffect, useId, useRef, useState } from 'react';
import { Button, Notice } from '../../components';

/**
 * Asked after leaving the settings (navigation or browser back) with unsaved changes: save them, discard them, or go back
 * to the settings. Escape goes back, so no change is lost or saved by accident.
 */
export default function UnsavedDialog({
  open,
  error,
  onSave,
  onDiscard,
  onBack,
}: {
  open: boolean;
  error: string;
  onSave: () => Promise<boolean>;
  onDiscard: () => void;
  onBack: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  async function save() {
    setBusy(true);
    try {
      await onSave();
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
      onCancel={event => {
        event.preventDefault();
        if (!busy) onBack();
      }}
    >
      <h2 id={titleId}>Änderungen speichern?</h2>
      <p>Du hast Einstellungen geändert, aber noch nicht gespeichert.</p>
      {error && <Notice error>{error}</Notice>}
      <div className="dialog-actions">
        <Button variant="ghost" disabled={busy} onClick={onBack}>
          Zurück zu den Einstellungen
        </Button>
        <Button disabled={busy} onClick={onDiscard}>
          Verwerfen
        </Button>
        <Button variant="primary" loading={busy} onClick={() => void save()}>
          Speichern
        </Button>
      </div>
    </dialog>
  );
}
