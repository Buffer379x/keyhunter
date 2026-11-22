import { useEffect, useId, useState } from 'react';
import { Icon, IconButton } from '../components';

/** Entries per page to choose from (Log, Abrufe, Wunschliste). */
export const PER_PAGE = [25, 50, 100, 200];

interface Stored {
  filter?: unknown;
  text?: unknown;
  perPage?: unknown;
}
function read(key: string): Stored {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    return value && typeof value === 'object' ? (value as Stored) : {};
  } catch {
    return {};
  }
}
function readPage(key: string): number {
  try {
    const page = Number(sessionStorage.getItem(`${key}.page`));
    return Number.isInteger(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

/**
 * The view of a list, kept when the owner leaves the page and comes back (0.9.1): filter, search text and page size are saved
 * in this browser, the page for this session. A new filter, search or page size goes back to page 1. `filters` are the
 * allowed filter values; an unknown stored one falls back to `fallback`.
 */
export function useListView<F extends string>(key: string, filters: readonly F[], fallback: F, defaultPerPage = 50) {
  const [initial] = useState(() => read(key));
  const [filter, setFilterValue] = useState<F>(() => (filters.includes(initial.filter as F) ? (initial.filter as F) : fallback));
  const [text, setText] = useState(() => (typeof initial.text === 'string' ? initial.text : ''));
  const [perPage, setPerPageValue] = useState(() => (PER_PAGE.includes(initial.perPage as number) ? (initial.perPage as number) : defaultPerPage));
  const [page, setPage] = useState(() => readPage(key));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ filter, text, perPage }));
    } catch {
      /* kept for this visit */
    }
  }, [key, filter, text, perPage]);
  useEffect(() => {
    try {
      sessionStorage.setItem(`${key}.page`, String(page));
    } catch {
      /* kept for this visit */
    }
  }, [key, page]);
  const setFilter = (value: F) => {
    setFilterValue(value);
    setPage(1);
  };
  const setPerPage = (value: number) => {
    setPerPageValue(value);
    setPage(1);
  };
  return { filter, setFilter, text, setText, perPage, setPerPage, page, setPage };
}

/** Clamp a page to the pages a list of `total` entries has. */
export const pageCount = (total: number, perPage: number) => Math.max(1, Math.ceil(total / perPage));

/** "Pro Seite" with the choices of PER_PAGE. */
export function PageSize({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const id = useId();
  return (
    <span className="page-size">
      <label htmlFor={id}>Pro Seite</label>
      <select id={id} value={value} onChange={event => onChange(Number(event.target.value))}>
        {PER_PAGE.map(n => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    </span>
  );
}

/** "26–50 von 312" and the buttons to the first, previous, next and last page. */
export function Pager({
  label,
  total,
  page,
  perPage,
  onPage,
}: {
  label: string;
  total: number;
  page: number;
  perPage: number;
  onPage: (page: number) => void;
}) {
  const pages = pageCount(total, perPage);
  const from = total === 0 ? 0 : (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  return (
    <nav className="pager" aria-label={`Seiten ${label}`}>
      <span className="mono" role="status">
        {from}–{to} von {total}
      </span>
      <span className="spacer" />
      <IconButton label="Erste Seite" disabled={page <= 1} onClick={() => onPage(1)}>
        <Icon name="first" />
      </IconButton>
      <IconButton label="Vorherige Seite" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        <Icon name="back" />
      </IconButton>
      <span className="pager-at">
        Seite <b className="mono">{page}</b> von <span className="mono">{pages}</span>
      </span>
      <IconButton label="Nächste Seite" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        <Icon name="chev" />
      </IconButton>
      <IconButton label="Letzte Seite" disabled={page >= pages} onClick={() => onPage(pages)}>
        <Icon name="last" />
      </IconButton>
    </nav>
  );
}
