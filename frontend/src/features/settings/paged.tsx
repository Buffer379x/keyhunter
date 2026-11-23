import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Paged } from '../../api';
import { Field, PanelHead, Seg } from '../../components';
import { PageSize, pageCount, useListView } from '../list-view';
export { Pager } from '../list-view';
import { usePolled } from '../../usePolled';

const REFRESH_MS = 30_000;

/**
 * A server-side paged list (0.8.3: Log and Abrufstatus): one filter, free-text search (applied 250 ms after the last key, like
 * the game search), the page and the page size, all kept when the owner leaves and comes back (0.9.1, `useListView`). Any
 * change of filter, search or size goes back to page 1. The open page is read again every 30 s, never while the tab is
 * hidden. A failed read keeps the last page and sets `failed`.
 */
export function usePaged<T extends Paged, F extends string>(path: string, filterName: string, key: string, filters: readonly F[], fallback: F) {
  const view = useListView(key, filters, fallback);
  const { filter, text, page, setPage, perPage } = view;
  const [query, setQuery] = useState(() => text.trim());
  const [failed, setFailed] = useState(false);
  // Only a changed search goes back to page 1 (not the first render: that reset a page chosen in the first 250 ms).
  useEffect(() => {
    const next = text.trim();
    if (next === query) return;
    const timer = window.setTimeout(() => {
      setQuery(next);
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [text, query, setPage]);
  const params = new URLSearchParams({ page: String(page), per_page: String(perPage) });
  if (filter) params.set(filterName, filter);
  if (query) params.set('q', query);
  const data = usePolled<T>(`${path}?${params}`, {
    every: REFRESH_MS,
    retry: REFRESH_MS,
    onData: next => {
      setFailed(false);
      // The list shrank below the open page (7 days passed, a filter): show the last page instead.
      const last = pageCount(next.total, next.per_page);
      if (page > last) setPage(last);
    },
    onError: () => setFailed(true),
  });
  return { ...view, data, failed };
}

/**
 * Head of a paged list: the filter (a segmented control), the search field and the page size. `label` names the list
 * ("Log", "Abrufe") for the accessible names.
 */
export function PagedTools<F extends string>({
  label,
  filter,
  filters,
  onFilter,
  text,
  onText,
  placeholder,
  perPage,
  onPerPage,
  children,
}: {
  label: string;
  filter: F;
  filters: { value: F; label: string }[];
  onFilter: (value: F) => void;
  text: string;
  onText: (text: string) => void;
  placeholder: string;
  perPage: number;
  onPerPage: (value: number) => void;
  children?: ReactNode;
}) {
  return (
    <PanelHead className="paged-tools">
      {children}
      <Seg label={`${label} nach Stufe filtern`} value={filter} onChange={onFilter} options={filters} />
      <span className="spacer" />
      <Field icon="search" className="paged-q">
        <input
          type="search"
          placeholder={placeholder}
          aria-label={`${label} durchsuchen`}
          value={text}
          maxLength={200}
          onChange={event => onText(event.target.value)}
        />
      </Field>
      <PageSize value={perPage} onChange={onPerPage} />
    </PanelHead>
  );
}
