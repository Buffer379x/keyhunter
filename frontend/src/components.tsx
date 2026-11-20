import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { Button, Icon } from './ui';

export { Icon, Button, IconButton, Chip, StatusChip, Price, formatPrice, Tabs, TabPanel, SegmentedControl, Card, MonoLabel, EmptyState, TargetLock, Switch } from './ui';
export { KeyMark, Brand } from './brand';
export function PageHeading({ title }: { title: string }) {
  return <header className="page-heading"><h1>{title}</h1></header>;
}
export function CardHeading({ icon, title, id, children }: { icon: string; title: string; id?: string; children?: ReactNode }) {
  return <div className="card-heading"><Icon name={icon} /><h3 id={id}>{title}</h3>{children}</div>;
}
export function Notice({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}
export function InfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={onClose}>
    <h2 id={titleId}>Grundpreis und Gebühren</h2>
    <p>Ein niedriger Shoppreis enthält möglicherweise noch nicht alle Kosten. Ohne belegte Gebühren bleibt der Gesamtpreis unbekannt.</p>
    <p>Du kannst pro Shop einen prozentualen Aufschlag einstellen. Daraus berechnete Preise werden als <strong>geschätzt</strong> gekennzeichnet. Der tatsächliche Kaufpreis kann abweichen.</p>
    <p>Ein Schätzwert ersetzt weder die Aktivierungsprüfung noch die Angaben des Shops.</p>
    <Button onClick={onClose}>Verstanden</Button>
  </dialog>;
}

export function ConfirmDialog({open,title,confirmLabel,cancelLabel='Abbrechen',busy=false,danger=false,onCancel,onConfirm,children}:{open:boolean;title:string;confirmLabel:string;cancelLabel?:string;busy?:boolean;/** Destructive action: the confirm button is styled as danger. */danger?:boolean;onCancel:()=>void;onConfirm:()=>void;children:ReactNode}) {
  const dialog=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  useEffect(()=>{if(open&&!dialog.current?.open)dialog.current?.showModal();else if(!open)dialog.current?.close();},[open]);
  return <dialog ref={dialog} aria-labelledby={titleId} onKeyDown={event=>{if(event.key==='Escape')event.stopPropagation();}} onCancel={event=>{event.preventDefault();event.stopPropagation();if(!busy)onCancel();}}>
    <h2 id={titleId}>{title}</h2>{children}<div className="dialog-actions"><Button secondary disabled={busy} onClick={onCancel}>{cancelLabel}</Button><Button variant={danger?'danger':'primary'} disabled={busy} onClick={onConfirm}>{busy?'Wird gespeichert …':confirmLabel}</Button></div>
  </dialog>;
}
