import { useSyncExternalStore } from 'react';
import { sections } from './features/settings/sections';
import type { Section } from './features/settings/sections';

/**
 * The URL is the app's route: `?view=` the page (none: the wishlist), `&section=` the settings tab (none: Allgemein),
 * `?item=` the open game below the wishlist with `&tab=` its tab (none: Preis), `&filter=` the wishlist's text filter.
 * Everything changes the URL through `navigate` (or browser back/forward), and every view reads it through `useRoute`.
 */
export type Page = 'wishlist' | 'settings' | 'alerts' | 'library' | 'cart';
const tabIds = ['preis', 'angebote', 'verlauf', 'editionen', 'alarm', 'zuordnungen'] as const;
export type TabId = (typeof tabIds)[number];
export interface Route {
  page: Page;
  section: Section;
  item: string | null;
  tab: TabId;
  filter: string;
}
type Param = 'view' | 'section' | 'item' | 'tab' | 'filter';

/** The tab of a URL (`?tab=`); "infos" is the name of the Zuordnungen tab before 1.0 (PROD-03), so old links keep working. */
function parseTab(value: string | null): TabId | null {
  const id = value === 'infos' ? 'zuordnungen' : value;
  return !!id && (tabIds as readonly string[]).includes(id) ? (id as TabId) : null;
}
function parse(href: string): Route {
  const url = new URL(href);
  const query = url.searchParams;
  const view = query.get('view');
  const section = query.get('section');
  return {
    page: view === 'settings' || view === 'alerts' || view === 'library' || view === 'cart' ? view : 'wishlist',
    section: sections.some(s => s.id === section) ? (section as Section) : 'general',
    item: query.get('item'),
    // An old link to the alarm editor (`#alert-editor-title`) opens the Alarm tab.
    tab: parseTab(query.get('tab')) ?? (url.hash === '#alert-editor-title' ? 'alarm' : 'preis'),
    filter: query.get('filter') ?? '',
  };
}

type Listener = (route: Route, previous: Route, browser: boolean) => void;
let current = parse(window.location.href);
let currentHref = window.location.href;
const listeners = new Set<Listener>();
function publish(next: Route, browser: boolean) {
  const previous = current;
  current = next;
  for (const listener of listeners) listener(next, previous, browser);
}
function follow(browser: boolean) {
  if (window.location.href === currentHref && !browser) return;
  currentHref = window.location.href;
  publish(parse(currentHref), browser);
}
window.addEventListener('popstate', () => follow(true));

/** Calls `listener` after every route change; `browser` is true for back/forward. Returns the unsubscribe. */
export function onRouteChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
const subscribe = (change: () => void) => onRouteChange(change);
/** The current route; the component renders again when it changes. */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current);
}

/**
 * Changes the URL: each parameter is set, or removed with null (undefined leaves it). A new history entry (only when the
 * URL changes, with `state`), or with `replace` the current one with its state and hash. `reset` starts from an empty URL.
 */
export function navigate(params: Partial<Record<Param, string | null | undefined>>, options: { replace?: boolean; reset?: boolean; state?: unknown } = {}) {
  const url = new URL(window.location.href);
  if (options.reset) url.search = '';
  if (options.reset || !options.replace) url.hash = '';
  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key);
    else if (value !== undefined) url.searchParams.set(key, value);
  }
  if (options.replace) window.history.replaceState(options.reset ? null : window.history.state, '', url);
  else if (url.href !== window.location.href) window.history.pushState(options.state ?? null, '', url);
  follow(false);
}

/** Opens a settings tab from any page. */
export function openSection(id: Section) {
  navigate({ view: 'settings', section: id === 'general' ? null : id }, { reset: true });
}

/**
 * History state of a game opened from the list: the number of history entries since the list (opening the game plus
 * every tab change). Going back that many steps reuses the list entry with its scroll position.
 */
const FROM_LIST = 'keyhunter.wishlist';
export const listDepth = () => Number((window.history.state as Record<string, unknown> | null)?.[FROM_LIST]) || 0;
export const fromList = (depth: number) => (depth ? { [FROM_LIST]: depth } : null);
/** Back to the list a game was opened from; false for a deep link. The list shows at once, the browser's popstate follows. */
export function returnToList(): boolean {
  const depth = listDepth();
  if (!depth) return false;
  window.history.go(-depth);
  publish({ ...current, item: null }, false);
  return true;
}
