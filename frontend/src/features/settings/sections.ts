import type { IconName } from '../../ui';

/** Settings sections as listed in the sidebar group "Einstellungen". The URL carries the section: ?view=settings&section=shops (Allgemein has no parameter). */
export type Section = 'general' | 'shops' | 'index' | 'notifications' | 'status' | 'system';
export const sections: { id: Section; label: string; icon: IconName }[] = [
  { id: 'general', label: 'Allgemein', icon: 'sliders' },
  { id: 'shops', label: 'Key-Shops', icon: 'store' },
  { id: 'index', label: 'Spieleindex', icon: 'book' },
  { id: 'notifications', label: 'Benachrichtigungen', icon: 'send' },
  { id: 'status', label: 'Abrufstatus', icon: 'activity' },
  { id: 'system', label: 'System', icon: 'shield' },
];
const ids = sections.map(s => s.id);
export const isSection = (value: string | null): value is Section => ids.includes(value as Section);
export const routeSection = (): Section => {
  const value = new URL(location.href).searchParams.get('section');
  return isSection(value) ? value : 'general';
};
export const sectionLabel = (id: Section) => sections.find(s => s.id === id)?.label ?? 'Allgemein';
