import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';

import { useModel } from '../src/hooks/use-model.ts';
import {
	__flueBindAgentModule,
	AGENT_IDENTITY_PATTERN,
	getRegisteredFlueAgents,
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
	resolveAgentDurability,
	resolveAgentIdentity,
	resolveAgentInitialDataSchema,
} from '../src/runtime/registration.ts';
import type { Agent } from '../src/types.ts';

afterEach(() => {
	resetFlueAgentRegistrationForTests();
});

function testAgent(): Agent {
	return function TestAgent() {
		useModel('anthropic/claude-haiku-4-5');
		return 'Test agent.';
	};
}

describe('registerFlueAgents()', () => {
	it('registers the application agent set in order', () => {
		const triage = testAgent();
		const support = testAgent();

		registerFlueAgents([
			{ identity: 'triage', agent: triage },
			{ identity: 'support', agent: support },
		]);

		expect(getRegisteredFlueAgents().map((record) => record.identity)).toEqual([
			'triage',
			'support',
		]);
		expect(getRegisteredFlueAgents().map((record) => record.agent)).toEqual([triage, support]);
	});

	it('registration also binds identity, so resolveAgentIdentity works for unbound functions', () => {
		const triage = testAgent();
		registerFlueAgents([{ identity: 'triage', agent: triage }]);
		expect(resolveAgentIdentity(triage)).toBe('triage');
	});

	it('replaces the previous registration wholesale when called again', () => {
		const first = testAgent();
		registerFlueAgents([{ identity: 'first', agent: first }]);
		const second = testAgent();
		registerFlueAgents([{ identity: 'second', agent: second }]);

		expect(getRegisteredFlueAgents().map((record) => record.identity)).toEqual(['second']);
	});

	it('rejects a value that is not a function', () => {
		expect(() =>
			registerFlueAgents([{ identity: 'bogus', agent: { initialize: () => ({}) } as never }]),
		).toThrow('must be a function');
	});

	it('rejects duplicate identities', () => {
		expect(() =>
			registerFlueAgents([
				{ identity: 'triage', agent: testAgent() },
				{ identity: 'triage', agent: testAgent() },
			]),
		).toThrow('Duplicate agent identity "triage"');
	});

	it('rejects the same agent function registered under two identities', () => {
		const shared = testAgent();
		expect(() =>
			registerFlueAgents([
				{ identity: 'one', agent: shared },
				{ identity: 'two', agent: shared },
			]),
		).toThrow('are the same function value');
	});

	it.each(['', 'bad:identity', '1leading-digit'])('rejects the invalid identity %j', (identity) => {
		expect(() => registerFlueAgents([{ identity, agent: testAgent() }])).toThrow('is invalid');
	});

	it('rejects registering an agent under a different identity than its module binding', () => {
		const triage = testAgent();
		__flueBindAgentModule(triage, { identity: 'triage' });
		expect(() => registerFlueAgents([{ identity: 'renamed', agent: triage }])).toThrow(
			'already bound to identity "triage"',
		);
	});
});

describe('__flueBindAgentModule()', () => {
	it('binds identity to the function and returns it', () => {
		const triage = testAgent();

		const returned = __flueBindAgentModule(triage, { identity: 'triage' });

		expect(returned).toBe(triage);
		expect(resolveAgentIdentity(triage)).toBe('triage');
	});

	it('is idempotent for module re-evaluation: rebinding the same identity is a no-op', () => {
		const triage = testAgent();
		__flueBindAgentModule(triage, { identity: 'triage' });
		__flueBindAgentModule(triage, { identity: 'triage' });

		expect(resolveAgentIdentity(triage)).toBe('triage');
	});

	it('rejects rebinding one function to a different identity', () => {
		const triage = testAgent();
		__flueBindAgentModule(triage, { identity: 'triage' });
		expect(() => __flueBindAgentModule(triage, { identity: 'other' })).toThrow(
			'already bound to identity "triage" and cannot be rebound as "other"',
		);
	});

	it('validates the identity charset', () => {
		expect(() => __flueBindAgentModule(testAgent(), { identity: 'a:b' })).toThrow('is invalid');
	});

	it('rejects a non-function value', () => {
		expect(() => __flueBindAgentModule({} as never, { identity: 'triage' })).toThrow(
			'must be a function',
		);
	});

	it('does not add the function to the registered application set', () => {
		__flueBindAgentModule(testAgent(), { identity: 'triage' });
		expect(getRegisteredFlueAgents()).toEqual([]);
	});
});

describe('AGENT_IDENTITY_PATTERN', () => {
	it('accepts PascalCase function names', () => {
		expect(AGENT_IDENTITY_PATTERN.test('IssueTriage')).toBe(true);
	});

	it('accepts kebab-case overrides', () => {
		expect(AGENT_IDENTITY_PATTERN.test('issue-triage')).toBe(true);
	});

	it('rejects identities containing ":"', () => {
		expect(AGENT_IDENTITY_PATTERN.test('bad:identity')).toBe(false);
	});

	it('rejects the empty string', () => {
		expect(AGENT_IDENTITY_PATTERN.test('')).toBe(false);
	});

	it('rejects a leading digit', () => {
		expect(AGENT_IDENTITY_PATTERN.test('1leading')).toBe(false);
	});
});

describe('resolveAgentIdentity()', () => {
	it('returns undefined for an anonymous, unbound function', () => {
		expect(resolveAgentIdentity(() => undefined)).toBeUndefined();
	});

	it('falls back to the function name when there is no binding or static', () => {
		function NamedAgent() {
			return undefined;
		}
		expect(resolveAgentIdentity(NamedAgent)).toBe('NamedAgent');
	});

	it('prefers the agentName static over the function name', () => {
		function NamedAgent() {
			return undefined;
		}
		NamedAgent.agentName = 'renamed-agent';
		expect(resolveAgentIdentity(NamedAgent)).toBe('renamed-agent');
	});

	it('rejects an agentName static that fails the identity pattern', () => {
		function NamedAgent() {
			return undefined;
		}
		NamedAgent.agentName = 'bad:identity';
		expect(() => resolveAgentIdentity(NamedAgent)).toThrow('invalid agentName static');
	});

	it('prefers the build-stamped binding over the agentName static', () => {
		function NamedAgent() {
			return undefined;
		}
		NamedAgent.agentName = 'static-name';
		__flueBindAgentModule(NamedAgent, { identity: 'bound-name' });
		expect(resolveAgentIdentity(NamedAgent)).toBe('bound-name');
	});
});

describe('resolveAgentInitialDataSchema()', () => {
	it('returns undefined when the agent has no initialData static', () => {
		expect(resolveAgentInitialDataSchema(testAgent())).toBeUndefined();
	});

	it('returns the schema when the initialData static is a valid Valibot schema', () => {
		const agent = testAgent();
		const schema = v.object({ issue: v.number() });
		agent.initialData = schema;
		expect(resolveAgentInitialDataSchema(agent)).toBe(schema);
	});

	it('rejects an initialData static that is not a Valibot schema', () => {
		const agent = testAgent();
		agent.initialData = { not: 'a schema' } as never;
		expect(() => resolveAgentInitialDataSchema(agent)).toThrow('invalid initialData static');
	});
});

describe('resolveAgentDurability()', () => {
	it('reads the durability static off the registered agent', () => {
		const agent = testAgent();
		agent.durability = { maxAttempts: 3, timeoutMs: 7_200_000 };
		registerFlueAgents([{ identity: 'triage', agent }]);
		expect(resolveAgentDurability('triage')).toEqual({ maxAttempts: 3, timeoutMs: 7_200_000 });
	});

	it('returns undefined for a registered agent with no durability static', () => {
		registerFlueAgents([{ identity: 'triage', agent: testAgent() }]);
		expect(resolveAgentDurability('triage')).toBeUndefined();
	});

	it('returns undefined for an unregistered identity', () => {
		expect(resolveAgentDurability('unbound')).toBeUndefined();
	});

	it('returns undefined when given an undefined identity', () => {
		expect(resolveAgentDurability(undefined)).toBeUndefined();
	});

	it('reads the current static value at resolve time', () => {
		// The static may be a computed expression (env-dependent policy); what
		// counts is the value on the function when the policy is applied.
		const agent = testAgent();
		agent.durability = { maxAttempts: 1 };
		registerFlueAgents([{ identity: 'triage', agent }]);
		agent.durability = { maxAttempts: 5 };
		expect(resolveAgentDurability('triage')).toEqual({ maxAttempts: 5 });
	});

	it('rejects a durability static with unknown fields', () => {
		const agent = testAgent();
		agent.durability = { maxAttempts: 3, retries: 7 } as never;
		registerFlueAgents([{ identity: 'triage', agent }]);
		expect(() => resolveAgentDurability('triage')).toThrow(
			'durability received unknown field "retries"',
		);
	});

	it('rejects a durability static with non-positive maxAttempts', () => {
		const agent = testAgent();
		agent.durability = { maxAttempts: 0 };
		registerFlueAgents([{ identity: 'triage', agent }]);
		expect(() => resolveAgentDurability('triage')).toThrow(
			'durability.maxAttempts must be a positive integer',
		);
	});

	it('rejects a durability static with non-positive timeoutMs', () => {
		const agent = testAgent();
		agent.durability = { timeoutMs: -1 };
		registerFlueAgents([{ identity: 'triage', agent }]);
		expect(() => resolveAgentDurability('triage')).toThrow(
			'durability.timeoutMs must be a positive integer',
		);
	});
});
