import { useEffect, useId, useRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    heart: 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
    settings: 'm10 3 .5 3h3L14 3m7 7-3 .5v3L21 14m-7 7-.5-3h-3L10 21M3 14l3-.5v-3L3 10M6 5l2 2m9 0 2-2M5 19l2-2m10 0 2 2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    game: 'M7 6h10c5 0 7 13 4 13-2 0-3-4-5-4H8c-2 0-3 4-5 4C0 19 2 6 7 6ZM5 10h6m-3-3v6m7-3h.1m3 2h.1',
    tag: 'm3 3 9 0 9 9-9 9-9-9V3Zm5 5h.1',
    layers: 'm12 3 10 6-10 6L2 9l10-6Zm-10 11 10 6 10-6M2 18l10 6 10-6',
    globe: 'M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0ZM2 12h20M12 2c-6 5-6 15 0 20 6-5 6-15 0-20Z',
    chart: 'M3 3v18h18M6 16l5-5 4 2 5-8',
    info: 'M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0ZM12 11v6m0-10v.1',
    plus: 'M12 4v16M4 12h16',
    arrow: 'M9 5l7 7-7 7',
    external: 'M14 3h7v7m0-7L10 14M10 3H3v18h18v-7',
    refresh: 'M21 10a9 9 0 0 0-16-5L2 8m0-5v5h5M3 14a9 9 0 0 0 16 5l3-3m0 5v-5h-5',
    logout: 'M9 3H3v18h6M9 12h13m-5-5 5 5-5 5',
    download: 'M12 3v12m-5-5 5 5 5-5M3 16v5h18v-5',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.info} /></svg>;
}
export function KeyMark({ small = false }: { small?: boolean }) {
  return <svg className={small ? 'key-mark small' : 'key-mark'} viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <circle cx="24" cy="20" r="16" stroke="#258ab4" strokeWidth="1.8" />
    <ellipse cx="25" cy="31" rx="24" ry="7" stroke="#00d6b3" strokeWidth="2" transform="rotate(-26 25 31)" />
    <circle cx="23" cy="18" r="6" stroke="#ff8b13" strokeWidth="4" />
    <path d="m23 24-6 13m2-5 5 2m-3-6 5 2" stroke="#ff8b13" strokeWidth="4" />
  </svg>;
}
export function Brand() {
  return <div className="brand" aria-label="KeyHunter"><KeyMark small /><strong><span>Key</span><span>Hunter</span></strong></div>;
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
