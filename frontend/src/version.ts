import pkg from '../package.json' with { type: 'json' };

/** App version, taken from package.json at build time. */
export const appVersion: string = pkg.version;
