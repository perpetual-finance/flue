import { describe, expect, it } from 'vitest';
import { renderAgentFunction } from '../src/hooks/render.ts';
import { useModel } from '../src/index.ts';
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

describe('agent function initialization', () => {
	it('rejects an initialization without a model', async () => {
		await expect(createContext().initializeRootHarness(() => undefined)).rejects.toThrow(
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
