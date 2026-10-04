import js from '@eslint/js';
import globals from 'globals';

/**
 * Flat ESLint config (ESLint 9+). The legacy `.eslintrc` next to it mirrors these
 * rules for editors that still read eslintrc; the CLI ignores it.
 *
 * MIGRATION: the only `ignores` left are the pre-rewrite files that
 * architecture §5 step 4 deletes (`src/proxy.js` + `src/tool-runtime/` +
 * `src/upstream/` + the pre-rewrite tests) and the `index.js` entry point it
 * replaces. T4 MUST empty this list once the monolith is gone; after that the
 * config should ignore nothing but generated output.
 */
export default [
    {
        ignores: [
            // Generated output.
            'node_modules/**',
            'coverage/**',
            // MIGRATION (remove with T4): pre-rewrite entry point and modules.
            'index.js',
            'src/proxy.js',
            'src/tool-runtime/**',
            'src/upstream/**',
            'tests/unit/*.test.js',
            'tests/integration/**',
            'tests/manual/**'
        ]
    },
    js.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrors: 'none'
                }
            ],
            'no-console': 'off',
            eqeqeq: ['error', 'smart'],
            'prefer-const': 'error',
            'no-var': 'error',
            'object-shorthand': ['error', 'properties']
        }
    },
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.jest
            }
        }
    }
];
