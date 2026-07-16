import { describe, expect, it } from 'vitest';
import { maximumPrivateContextRecentTokens } from '../src/runtime/private-context.ts';

describe('private-context model budget', () => {
	it('reduces the retained public suffix by the active private and fixed prompt budget', () => {
		const common = {
			contextWindow: 2_000,
			reserveTokens: 200,
			configuredKeepRecentTokens: 1_200,
			systemPromptByteLength: 100,
		};

		expect(
			maximumPrivateContextRecentTokens({ ...common, privateContextByteLength: 0 }),
		).toBe(1_200);
		expect(
			maximumPrivateContextRecentTokens({ ...common, privateContextByteLength: 900 }),
		).toBe(542);
	});

	it('keeps one token when the non-compactable budget consumes the window', () => {
		expect(
			maximumPrivateContextRecentTokens({
				contextWindow: 1_024,
				reserveTokens: 256,
				configuredKeepRecentTokens: 500,
				privateContextByteLength: 900,
				systemPromptByteLength: 100,
			}),
		).toBe(1);
	});
});
