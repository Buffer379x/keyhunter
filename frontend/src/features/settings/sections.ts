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
export const sectionLabel = (id: Section) => sections.find(s => s.id === id)?.label ?? 'Allgemein';
