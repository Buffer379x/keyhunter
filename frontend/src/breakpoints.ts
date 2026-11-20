// Breakpoints in px (design v4 prototype). Keep in sync with --bp-* in styles/tokens.css (tests/breakpoints.test.ts checks it).
// sm: phone layout (no breadcrumbs, search fills the top bar). md: the sidebar becomes a drawer. lg: content in one column.
export const breakpoints = { sm: 720, md: 900, lg: 1180 } as const;
export const mediaQuery = {
  /** The sidebar is a drawer opened from the top bar. */
  drawer: `(max-width: ${breakpoints.md}px)`,
} as const;
