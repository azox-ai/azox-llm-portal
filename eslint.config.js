export default [
  {
    files: ['src/**/*.js', 'test/**/*.js'],
    ignores: ['node_modules/**'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { Buffer: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Response: 'readonly', Request: 'readonly', fetch: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', queueMicrotask: 'readonly', process: 'readonly' } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-undef': 'error',
    },
  },
];
