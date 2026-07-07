import { describe, expect, it, vi } from 'vitest';
import { defineAgent, defineAgentProfile, defineTool } from '../src/index.ts';
import type { FlueContextConfig } from '../src/internal.ts';
import { createFlueContext, resolveModel } from '../src/internal.ts';
import type { AgentProfile, ToolDefinition } from '../src/types.ts';
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

function createTool(name: string): ToolDefinition {
	return defineTool({
		name,
		description: `Run ${name}.`,
		run: async () => name,
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
});

describe('defineAgentProfile()', () => {
	it('rejects unknown profile fields when a profile contains unsupported configuration', () => {
		expect(() => defineAgentProfile({ model: 'anthropic/claude-haiku-4-5', unsupported: true } as never)).toThrow(
			'unknown agent profile field "unsupported"',
		);
	});

	it('rejects a skill when its description is missing', () => {
		expect(() => defineAgentProfile({ skills: [{ name: 'triage' }] } as never)).toThrow(
			'skills[0].description',
		);
	});

	it('rejects a tool when its run callback is missing', () => {
		expect(() =>
			defineAgentProfile({
				tools: [{ name: 'lookup', description: 'Look up a value.' }],
			} as never),
		).toThrow('tools[0] run');
	});

	it('rejects a subagent when its name does not start with a letter', () => {
		expect(() => defineAgentProfile({ subagents: [{ name: '1invalid', model: 'anthropic/claude-haiku-4-5' }] })).toThrow(
			'must start with a letter',
		);
	});

	it('rejects duplicate tool names when a profile repeats a tool name', () => {
		expect(() =>
			defineAgentProfile({ tools: [createTool('lookup'), createTool('lookup')] }),
		).toThrow('duplicate tool name');
	});

	it('rejects duplicate skill names when a profile repeats a skill name', () => {
		expect(() =>
			defineAgentProfile({
				skills: [
					{ name: 'triage', description: 'Triage requests.' },
					{ name: 'triage', description: 'Triage other requests.' },
				],
			}),
		).toThrow('duplicate skill name');
	});

	it('rejects duplicate subagent names when a profile repeats a subagent name', () => {
		expect(() =>
			defineAgentProfile({
				subagents: [
					{ name: 'delegate', model: 'anthropic/claude-haiku-4-5' },
					{ name: 'delegate', model: 'anthropic/claude-haiku-4-5' },
				],
			}),
		).toThrow('duplicate subagent name');
	});

	it('rejects circular profiles when subagents refer back to an active profile definition', () => {
		const profile = { name: 'loop' } as AgentProfile;
		profile.subagents = [profile];

		expect(() => defineAgentProfile(profile)).toThrow('circular subagents');
	});

	it('accepts valid durability config on a profile', () => {
		expect(() =>
			defineAgentProfile({ durability: { maxAttempts: 5, timeoutMs: 21_600_000 } }),
		).not.toThrow();
		expect(() => defineAgentProfile({ durability: {} })).not.toThrow();
	});

	it('rejects durability config with unknown fields', () => {
		expect(() =>
			defineAgentProfile({ durability: { maxAttempts: 5, unknown: true } } as never),
		).toThrow('unknown field "unknown"');
	});

	it('rejects durability config with non-positive maxAttempts', () => {
		expect(() => defineAgentProfile({ durability: { maxAttempts: 0 } })).toThrow(
			'positive integer',
		);
		expect(() => defineAgentProfile({ durability: { maxAttempts: -1 } })).toThrow(
			'positive integer',
		);
		expect(() => defineAgentProfile({ durability: { maxAttempts: 1.5 } })).toThrow(
			'positive integer',
		);
	});

	it('rejects durability config with non-positive timeoutMs', () => {
		expect(() => defineAgentProfile({ durability: { timeoutMs: 0 } })).toThrow('positive integer');
		expect(() => defineAgentProfile({ durability: { timeoutMs: -1 } })).toThrow('positive integer');
	});

	it('rejects durability config when declared on a subagent profile', () => {
		expect(() =>
			defineAgentProfile({
				subagents: [{ name: 'helper', model: 'anthropic/claude-haiku-4-5', durability: { maxAttempts: 3 } }],
			}),
		).toThrow('must not declare durability');
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
