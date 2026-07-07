import { describe, expect, it } from 'vitest';
import { defineAgent } from '../src/index.ts';
import type { FlueContextConfig } from '../src/internal.ts';
import { createFlueContext, resolveModel } from '../src/internal.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

function createContext(overrides: Partial<FlueContextConfig> = {}) {
	return createFlueContext({
		id: 'agent-instance',
		env: { API_KEY: 'secret' },
		agentConfig: {
			resolveModel: () => resolveModel('anthropic/claude-haiku-4-5'),
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		...overrides,
	});
}

describe('defineAgent()', () => {
	it('rejects invalid input when it does not receive a capability function', () => {
		expect(() => defineAgent(null as never, { model: 'anthropic/claude-haiku-4-5' })).toThrow(
			'requires a function',
		);
	});

	it('rejects unknown config fields', () => {
		expect(() =>
			defineAgent(() => undefined, {
				model: 'anthropic/claude-haiku-4-5',
				unsupported: true,
			} as never),
		).toThrow('received unknown agent config field');
	});

	it('rejects a config without a model', () => {
		expect(() => defineAgent(() => undefined, {} as never)).toThrow('config is invalid');
	});

	it('rejects an invalid thinking level', () => {
		expect(() =>
			defineAgent(() => undefined, {
				model: 'anthropic/claude-haiku-4-5',
				thinkingLevel: 'over 9000' as never,
			}),
		).toThrow('thinkingLevel must be one of');
	});

	it('rejects compaction config with unknown fields', () => {
		expect(() =>
			defineAgent(() => undefined, {
				model: 'anthropic/claude-haiku-4-5',
				compaction: { reserveTokens: 1024, surprise: true } as never,
			}),
		).toThrow('compaction received unknown field "surprise"');
	});

	it('rejects durability config with unknown fields', () => {
		expect(() =>
			defineAgent(() => undefined, {
				model: 'anthropic/claude-haiku-4-5',
				durability: { maxAttempts: 3, retries: 7 } as never,
			}),
		).toThrow('durability received unknown field "retries"');
	});

	it('rejects durability config with non-positive maxAttempts', () => {
		expect(() =>
			defineAgent(() => undefined, {
				model: 'anthropic/claude-haiku-4-5',
				durability: { maxAttempts: 0 },
			}),
		).toThrow('durability.maxAttempts must be a positive integer');
	});

	it('rejects durability config with non-positive timeoutMs', () => {
		expect(() =>
			defineAgent(() => undefined, {
				model: 'anthropic/claude-haiku-4-5',
				durability: { timeoutMs: -1 },
			}),
		).toThrow('durability.timeoutMs must be a positive integer');
	});

	it('accepts durability config when an agent definition supplies it', async () => {
		const harness = await createContext().initializeRootHarness(
			defineAgent(() => undefined, {
				model: 'anthropic/claude-haiku-4-5',
				durability: { maxAttempts: 3, timeoutMs: 7_200_000 },
			}),
		);
		expect(harness).toBeDefined();
	});
});
