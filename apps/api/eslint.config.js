// ESLint flat config (ESLint 10 + typescript-eslint 8). Type-aware linting is not
// enabled deliberately — it keeps lint fast and independent of tsconfig project wiring;
// the TypeScript compiler (npm run typecheck) is the authority on types.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      // TypeScript already resolves identifiers/globals; the core rule is redundant here.
      'no-undef': 'off',
    },
  },
);
