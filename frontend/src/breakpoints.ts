// Breakpoints in px. Keep in sync with --bp-* in styles/tokens.css (tests/breakpoints.test.ts checks it).
// sm: below it single column with a bottom tab bar. md: from here sidebar navigation. lg: wide detail layout.
export const breakpoints = { sm: 640, md: 1024, lg: 1440 } as const;
export const mediaQuery = {
  /** Sidebar navigation and Abrufstatus card. */
  desktop: `(min-width: ${breakpoints.md}px)`,
} as const;
