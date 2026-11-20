import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { breakpoints } from '../src/breakpoints.ts';

test('breakpoint constants in TypeScript and tokens.css come from the same numbers', () => {
  const css = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
  for (const [name, px] of Object.entries(breakpoints)) {
    assert.match(css, new RegExp(`--bp-${name}:\\s*${px}px;`), `--bp-${name} must be ${px}px`);
  }
});

test('tokens.css is the only stylesheet with colour literals that new shell and ui styles may rely on', () => {
  for (const file of ['shell.css', 'ui.css']) {
    const css = readFileSync(new URL(`../src/styles/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, `${file} must use tokens only`);
  }
});
