import { afterEach, describe, expect, it } from 'vitest';
import { renderAgentFunction } from '../src/hooks/render.ts';
import { defineAgent, useModel } from '../src/index.ts';
import type { FlueContextConfig } from '../src/internal.ts';
import { createFlueContext, resolveModel } from '../src/internal.ts';
import {
	__flueBindAgentModule,
	resetFlueAgentRegistrationForTests,
} from '../src/runtime/registration.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

afterEach(() => {
	resetFlueAgentRegistrationForTests();
});

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
		expect(() => defineAgent(null as never)).toThrow('requires a function');
	});

	it('rejects an initialization without a model', async () => {
		await expect(createContext().initializeRootHarness(defineAgent(() => undefined))).rejects.toThrow(
			"requires a model. Call useModel('provider-id/model-id')",
		);
	});
});

describe('useModel()', () => {
	it('rejects a second call in one render', () => {
		expect(() =>
			renderAgentFunction(() => {
				useModel('anthropic/claude-haiku-4-5');
				useModel('anthropic/claude-haiku-4-5');
			}),
		).toThrow('useModel() was called twice in one render');
	});

	it('rejects an empty model specifier', () => {
		expect(() =>
			renderAgentFunction(() => {
				useModel('' as never);
			}),
		).toThrow('requires a model specifier string');
	});

	it('rejects unknown option fields', () => {
		expect(() =>
			renderAgentFunction(() => {
				useModel('anthropic/claude-haiku-4-5', { unsupported: true } as never);
			}),
		).toThrow('useModel() options received unknown field "unsupported"');
	});

	it('rejects an invalid thinking level', () => {
		expect(() =>
			renderAgentFunction(() => {
				useModel('anthropic/claude-haiku-4-5', { thinkingLevel: 'over 9000' as never });
			}),
		).toThrow('thinkingLevel must be one of');
	});

	it('rejects compaction options with unknown fields', () => {
		expect(() =>
			renderAgentFunction(() => {
				useModel('anthropic/claude-haiku-4-5', {
					compaction: { reserveTokens: 1024, surprise: true } as never,
				});
			}),
		).toThrow('compaction received unknown field "surprise"');
	});

	it('composes the model and tuning into the render config', () => {
		const config = renderAgentFunction(() => {
			useModel('anthropic/claude-haiku-4-5', {
				thinkingLevel: 'high',
				compaction: { reserveTokens: 2048 },
			});
			return 'Instructions.';
		});
		expect(config.model).toBe('anthropic/claude-haiku-4-5');
		expect(config.thinkingLevel).toBe('high');
		expect(config.compaction).toEqual({ reserveTokens: 2048 });
	});
});

describe('`durability` module export (binding contract)', () => {
	it('rejects durability with unknown fields', () => {
		expect(() =>
			__flueBindAgentModule(
				defineAgent(() => undefined),
				{ identity: 'triage', durability: { maxAttempts: 3, retries: 7 } as never },
			),
		).toThrow('durability received unknown field "retries"');
	});

	it('rejects durability with non-positive maxAttempts', () => {
		expect(() =>
			__flueBindAgentModule(
				defineAgent(() => undefined),
				{ identity: 'triage', durability: { maxAttempts: 0 } },
			),
		).toThrow('durability.maxAttempts must be a positive integer');
	});

	it('rejects durability with non-positive timeoutMs', () => {
		expect(() =>
			__flueBindAgentModule(
				defineAgent(() => undefined),
				{ identity: 'triage', durability: { timeoutMs: -1 } },
			),
		).toThrow('durability.timeoutMs must be a positive integer');
	});

	it('accepts a durability export when an agent module supplies it', async () => {
		const agent = defineAgent(() => {
			useModel('anthropic/claude-haiku-4-5');
		});
		__flueBindAgentModule(agent, {
			identity: 'triage',
			durability: { maxAttempts: 3, timeoutMs: 7_200_000 },
		});
		const harness = await createContext().initializeRootHarness(agent);
		expect(harness).toBeDefined();
	});
});
