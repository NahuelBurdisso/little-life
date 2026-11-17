import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * Lint for what the compiler cannot see. `tsc` (strict, noUnusedLocals) already covers
 * types and dead locals, so this stays small on purpose: the syntax-only TypeScript
 * rules (no type information, so the whole repo lints in seconds) and the React hooks
 * rules, which are the ones that catch real bugs in the client.
 *
 * `no-explicit-any` is a warning, not an error: the codebase had ~300 of them when lint
 * arrived (JSON columns, tRPC payloads). They are debt to pay down file by file, and an
 * error would only have taught everyone to ignore the lint run.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**', 'node_modules/**', 'data/**', 'public/**', 'assets-raw/**',
      '.claude/**', 'docs/**', 'server/db/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // tsc reports unused locals and parameters (and honours the `_name` convention).
      '@typescript-eslint/no-unused-vars': 'off',
      // `while (true)` loops with a break are used on purpose in the generators.
      'no-constant-condition': ['error', { checkLoops: false }],
      // `let { day, hour, minute, totalTicks } = time` where only some are reassigned.
      'prefer-const': ['error', { destructuring: 'all' }],
      // Flags `let x = null; try { x = ... }` and hash finalizers (`return (h ^= ...)`):
      // every hit in this codebase was an idiom, none a mistake.
      'no-useless-assignment': 'off',
      // The dialogue sanitizer and the god-power input filter match control characters
      // and multi-codepoint emoji on purpose (ai/sanitizeDialogue.ts, lib/godPowers.ts).
      'no-control-regex': 'off',
      'no-misleading-character-class': 'off',
    },
  },
  {
    // Vite's documented way to type the `test` block of a shared config.
    files: ['vite.config.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);
