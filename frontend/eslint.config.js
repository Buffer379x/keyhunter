import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Minimal on purpose: the recommended correctness rules plus the two hook rules. Style is Prettier's job.
export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'test-results', 'playwright-report'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, varsIgnorePattern: '^_', argsIgnorePattern: '^_' }] } },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'e2e/**/*.ts', 'scripts/**/*.mjs', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
  },
);
