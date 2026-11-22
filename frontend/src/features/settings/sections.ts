import type { IconName } from '../../ui';

/** Tabs of the settings page (0.8.3; before, entries of the sidebar). The URL carries the tab: ?view=settings&section=shops (Allgemein has no parameter). */
export type Section = 'general' | 'shops' | 'index' | 'notifications' | 'status' | 'log' | 'system';
export const sections: { id: Section; label: string; icon: IconName }[] = [
  { id: 'general', label: 'Allgemein', icon: 'sliders' },
  { id: 'shops', label: 'Key-Shops', icon: 'store' },
  { id: 'index', label: 'Spieleindex', icon: 'book' },
  { id: 'notifications', label: 'Benachrichtigungen', icon: 'send' },
  { id: 'status', label: 'Abrufstatus', icon: 'activity' },
  { id: 'log', label: 'Log', icon: 'log' },
  { id: 'system', label: 'System', icon: 'shield' },
];
const ids = sections.map(s => s.id);
export const isSection = (value: string | null): value is Section => ids.includes(value as Section);
export const routeSection = (): Section => {
  const value = new URL(location.href).searchParams.get('section');
  return isSection(value) ? value : 'general';
};
export const sectionLabel = (id: Section) => sections.find(s => s.id === id)?.label ?? 'Allgemein';
/** Open a settings tab from a page without access to the app navigation; App follows the URL through popstate. */
export function openSection(id: Section) {
  const url = new URL(location.href);
  url.search = id === 'general' ? '?view=settings' : `?view=settings&section=${id}`;
  url.hash = '';
  history.pushState(null, '', url);
  dispatchEvent(new PopStateEvent('popstate'));
}
