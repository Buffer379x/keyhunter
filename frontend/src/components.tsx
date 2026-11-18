import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function KeyMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'key-mark small' : 'key-mark'} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.5" strokeDasharray="84 42" transform="rotate(-45 24 24)" />
    <circle cx="18" cy="19" r="7" stroke="currentColor" strokeWidth="3" />
    <path d="m23 24 12 12m-5-5 4-4m-8 0 4-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    <circle cx="40" cy="12" r="3" className="key-satellite" />
  </svg>;
}
export function Brand() {
  return <div className="brand"><KeyMark small /><div><strong>KEYHUNTER</strong><span>GLOBAL</span></div></div>;
}
export function Button({ secondary = false, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { secondary?: boolean }) {
  return <button className={`button ${secondary ? 'secondary' : ''} ${className}`} {...props} />;
}
export function Notice({ error = false, children }: { error?: boolean; children: ReactNode }) {
  return <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>;
}
export function InfoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  return <dialog ref={ref} aria-labelledby={titleId} onCancel={onClose}>
    <p className="eyebrow">NACHVOLLZIEHBARE PREISE</p><h2 id={titleId}>Grundpreis und Gebühren</h2>
    <p>Ein niedriger Shoppreis enthält möglicherweise noch nicht alle Kosten. Ohne belegte Gebühren bleibt der Gesamtpreis unbekannt.</p>
    <p>Du kannst pro Shop einen prozentualen Aufschlag einstellen. Daraus berechnete Preise werden als <strong>geschätzt</strong> gekennzeichnet. Der tatsächliche Kaufpreis kann abweichen.</p>
    <p>Ein Schätzwert ersetzt weder die Aktivierungsprüfung noch die Angaben des Shops.</p>
    <Button onClick={onClose}>Verstanden</Button>
  </dialog>;
}
