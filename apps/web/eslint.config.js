// ESLint flat config (ESLint 10 + typescript-eslint 8 + react-hooks). Type-aware linting
// is not enabled; `npm run typecheck` (tsc) is the authority on types. The react-hooks
// plugin is registered manually because its bundled preset still uses the legacy
// array-form `plugins` key, which flat config rejects.
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // TypeScript resolves identifiers/globals; the core rule is redundant here.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
