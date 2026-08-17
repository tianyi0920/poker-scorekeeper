const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
      globals: {
        afterAll: 'readonly',
        beforeAll: 'readonly',
        describe: 'readonly',
        expect: 'readonly',
        it: 'readonly',
        process: 'readonly'
      }
    }
  }
);
