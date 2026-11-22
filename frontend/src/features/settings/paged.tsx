import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../api';
import type { Paged } from '../../api';
import { Field, Icon, IconButton, PanelHead, Seg } from '../../components';
import { whenVisible } from '../../poll';

/** Entries per page to choose from; the choice is remembered per list in this browser. */
export const PER_PAGE = [25, 50, 100, 200];
const REFRESH_MS = 30_000;

function readPerPage(key: string): number {
  try { const value = Number(localStorage.getItem(key)); return PER_PAGE.includes(value) ? value : 50; } catch { return 50; }
}

/**
 * A server-side paged list (0.8.3: Log and Abrufstatus): free-text search (applied 250 ms after the last key, like the game
 * search), one filter, the page and the page size. Any change of search, filter or size goes back to page 1. The open page
 * is read again every 30 s, never while the tab is hidden. A failed read keeps the last page and sets `failed`.
 */
export function usePaged<T extends Paged>(path: string, filterName: string, filter: string, perPageKey: string) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(() => readPerPage(perPageKey));
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  // A changed filter goes back to page 1 right away (state adjusted while rendering, before the read).
  const [shownFilter, setShownFilter] = useState(filter);
  if (filter !== shownFilter) { setShownFilter(filter); setPage(1); }
  // Only a changed search goes back to page 1 (not the first render: that reset a page chosen in the first 250 ms).
  useEffect(() => {
    const next = text.trim();
    if (next === query) return;
    const timer = window.setTimeout(() => { setQuery(next); setPage(1); }, 250);
    return () => window.clearTimeout(timer);
  }, [text, query]);
  useEffect(() => {
    const controller = new AbortController();
    let cancel = () => {};
    const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (filter) params.set(filterName, filter);
    if (query) params.set('q', query);
    const load = () => {
      api<T>(`${path}?${params}`, 'GET', undefined, undefined, controller.signal)
        .then(next => {
          if (controller.signal.aborted) return;
          setData(next); setFailed(false);
          // The list shrank below the open page (7 days passed, a filter): show the last page instead.
          const last = Math.max(1, Math.ceil(next.total / next.per_page));
          if (page > last) setPage(last);
        })
        .catch(() => { if (!controller.signal.aborted) setFailed(true); })
        .finally(() => { if (!controller.signal.aborted) cancel = whenVisible(load, REFRESH_MS); });
    };
    load();
    return () => { controller.abort(); cancel(); };
  }, [path, filterName, filter, query, page, perPage]);
  function choosePerPage(value: number) {
    setPerPage(value); setPage(1);
    try { localStorage.setItem(perPageKey, String(value)); } catch { /* only a convenience */ }
  }
  return { data, failed, text, setText, page, setPage, perPage, choosePerPage };
}

/**
 * Head of a paged list: the filter (a segmented control), the search field and the page size. `label` names the list
 * ("Log", "Abrufe") for the accessible names.
 */
export function PagedTools<F extends string>({ label, filter, filters, onFilter, text, onText, placeholder, perPage, onPerPage, children }: {
  label: string; filter: F; filters: { value: F; label: string }[]; onFilter: (value: F) => void;
  text: string; onText: (text: string) => void; placeholder: string; perPage: number; onPerPage: (value: number) => void; children?: ReactNode;
}) {
  const sizeId = useId();
  return <PanelHead className="paged-tools">
    {children}
    <Seg label={`${label} nach Stufe filtern`} value={filter} onChange={onFilter} options={filters} />
    <span className="spacer" />
    <Field icon="search" className="paged-q"><input type="search" placeholder={placeholder} aria-label={`${label} durchsuchen`} value={text} maxLength={200} onChange={event => onText(event.target.value)} /></Field>
    <span className="paged-size"><label htmlFor={sizeId}>Pro Seite</label>
      <select id={sizeId} value={perPage} onChange={event => onPerPage(Number(event.target.value))}>{PER_PAGE.map(n => <option key={n} value={n}>{n}</option>)}</select>
    </span>
  </PanelHead>;
}

/** "26–50 von 312" and the buttons to the first, previous, next and last page. */
export function Pager({ label, total, page, perPage, onPage }: { label: string; total: number; page: number; perPage: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return <nav className="pager" aria-label={`Seiten ${label}`}>
    <span className="mono" role="status">{from}–{to} von {total}</span>
    <span className="spacer" />
    <IconButton label="Erste Seite" disabled={page <= 1} onClick={() => onPage(1)}><Icon name="back" /><Icon name="back" className="pager-double" /></IconButton>
    <IconButton label="Vorherige Seite" disabled={page <= 1} onClick={() => onPage(page - 1)}><Icon name="back" /></IconButton>
    <span className="pager-at">Seite <b className="mono">{page}</b> von <span className="mono">{pages}</span></span>
    <IconButton label="Nächste Seite" disabled={page >= pages} onClick={() => onPage(page + 1)}><Icon name="chev" /></IconButton>
    <IconButton label="Letzte Seite" disabled={page >= pages} onClick={() => onPage(pages)}><Icon name="chev" /><Icon name="chev" className="pager-double" /></IconButton>
  </nav>;
}
