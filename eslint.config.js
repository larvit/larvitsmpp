import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['dist/', 'dist-test/'] },
	eslint.configs.recommended,
	tseslint.configs.strictTypeChecked,
	tseslint.configs.stylisticTypeChecked,
	{
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/consistent-type-definitions': ['error', 'type'],
			'@typescript-eslint/no-floating-promises': ['error', {
				allowForKnownSafeCalls: [
					{ from: 'package', name: ['describe', 'it', 'test'], package: 'node:test' },
				],
			}],
			'@typescript-eslint/no-non-null-assertion': 'error',
			'no-console': 'error',
		},
	},
	{
		files: ['src/**/*.ts'],
		rules: {
			complexity: ['error', 10],
			'max-lines': ['error', { max: 350, skipBlankLines: true, skipComments: true }],
			'max-lines-per-function': ['error', { max: 40, skipBlankLines: true, skipComments: true }],
			'max-params': ['error', 5],
		},
	},
	{
		// The spec tables are data: their length tracks the specification, not any complexity.
		files: ['src/defs/*.ts'],
		rules: { 'max-lines': 'off' },
	},
	{
		// ESLint counts every ?. and ?? in dlrFromPdu as a branch; the 19 is 26 lines of flat field resolution.
		files: ['src/dlr.ts'],
		rules: { complexity: ['error', 19] },
	},
	{
		// ESC (0x1B) is the GSM 03.38 escape character, so it belongs in these patterns.
		files: ['src/defs/encodings.ts'],
		rules: { 'no-control-regex': 'off' },
	},
	{
		// An async event listener is a documented, supported shape; EventEmitter types listeners void.
		files: ['test/*.test.ts'],
		rules: {
			'@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
		},
	},
	{
		files: ['eslint.config.js'],
		extends: [tseslint.configs.disableTypeChecked],
	},
);
