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
		// ESC (0x1B) is the GSM 03.38 escape character, so it belongs in these patterns.
		files: ['src/defs/encodings.ts'],
		rules: { 'no-control-regex': 'off' },
	},
	{
		files: ['eslint.config.js'],
		extends: [tseslint.configs.disableTypeChecked],
	},
);
