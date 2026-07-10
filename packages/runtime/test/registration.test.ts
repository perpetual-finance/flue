import type { MiddlewareHandler } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';

import { defineAgent } from '../src/agent-definition.ts';
import { useModel } from '../src/hooks/use-model.ts';
import {
	__flueBindAgentModule,
	getRegisteredFlueAgents,
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
	resolveAgentModuleBinding,
} from '../src/runtime/registration.ts';
import type { FunctionAgentDefinition } from '../src/types.ts';

afterEach(() => {
	resetFlueAgentRegistrationForTests();
});

function testAgent(): FunctionAgentDefinition {
	return defineAgent(() => {
		useModel('anthropic/claude-haiku-4-5');
		return 'Test agent.';
	});
}

describe('registerFlueAgents()', () => {
	it('registers the application agent set and resolves bindings by definition identity', () => {
		const triage = testAgent();
		const support = testAgent();
		const route: MiddlewareHandler = async (_c, next) => next();

		registerFlueAgents([
			{ definition: triage, identity: 'triage', route, description: 'Triage agent' },
			{ definition: support, identity: 'support' },
		]);

		expect(getRegisteredFlueAgents().map((record) => record.identity)).toEqual([
			'triage',
			'support',
		]);
		expect(resolveAgentModuleBinding(triage)).toMatchObject({
			identity: 'triage',
			route,
			description: 'Triage agent',
		});
		expect(resolveAgentModuleBinding(support)).toMatchObject({ identity: 'support' });
	});

	it('replaces the previous registration wholesale when called again', () => {
		const first = testAgent();
		registerFlueAgents([{ definition: first, identity: 'first' }]);
		const second = testAgent();
		registerFlueAgents([{ definition: second, identity: 'second' }]);

		expect(getRegisteredFlueAgents().map((record) => record.identity)).toEqual(['second']);
	});

	it('rejects a value that is not a defineAgent(...) product', () => {
		expect(() =>
			registerFlueAgents([
				{ definition: { initialize: () => ({}) } as unknown as FunctionAgentDefinition, identity: 'bogus' },
			]),
		).toThrow('Agent "bogus" must default-export defineAgent(Agent)');
	});

	it('rejects duplicate identities', () => {
		expect(() =>
			registerFlueAgents([
				{ definition: testAgent(), identity: 'triage' },
				{ definition: testAgent(), identity: 'triage' },
			]),
		).toThrow('Duplicate agent identity "triage"');
	});

	it('rejects the same definition registered under two identities', () => {
		const shared = testAgent();
		expect(() =>
			registerFlueAgents([
				{ definition: shared, identity: 'one' },
				{ definition: shared, identity: 'two' },
			]),
		).toThrow('Agents "one" and "two" default-export the same agent definition value');
	});

	it.each(['', 'bad:identity'])('rejects the invalid identity %j', (identity) => {
		expect(() => registerFlueAgents([{ definition: testAgent(), identity }])).toThrow(
			'must be non-empty and must not contain ":"',
		);
	});

	it('rejects non-callable metadata middleware and empty descriptions', () => {
		expect(() =>
			registerFlueAgents([
				{
					definition: testAgent(),
					identity: 'triage',
					route: 'nope' as unknown as never,
				},
			]),
		).toThrow('route export must be a callable Hono middleware value');
		expect(() =>
			registerFlueAgents([
				{ definition: testAgent(), identity: 'triage', description: '   ' },
			]),
		).toThrow('description export must be a non-empty string');
	});

	it('rejects registering a definition under a different identity than its module binding', () => {
		const triage = testAgent();
		__flueBindAgentModule(triage, { identity: 'triage' });
		expect(() => registerFlueAgents([{ definition: triage, identity: 'renamed' }])).toThrow(
			'already bound to identity "triage"',
		);
	});
});

describe('__flueBindAgentModule()', () => {
	it('binds identity and module metadata to the definition and returns it', () => {
		const triage = testAgent();
		const route: MiddlewareHandler = async (_c, next) => next();

		const returned = __flueBindAgentModule(triage, {
			identity: 'triage',
			route,
			description: 'Triage agent',
		});

		expect(returned).toBe(triage);
		expect(resolveAgentModuleBinding(triage)).toMatchObject({
			identity: 'triage',
			route,
			description: 'Triage agent',
		});
	});

	it('is idempotent for module re-evaluation: rebinding the same identity replaces metadata', () => {
		const triage = testAgent();
		__flueBindAgentModule(triage, { identity: 'triage' });
		const route: MiddlewareHandler = async (_c, next) => next();
		__flueBindAgentModule(triage, { identity: 'triage', route });

		expect(resolveAgentModuleBinding(triage)).toMatchObject({ identity: 'triage', route });
	});

	it('rejects rebinding one definition to a different identity', () => {
		const triage = testAgent();
		__flueBindAgentModule(triage, { identity: 'triage' });
		expect(() => __flueBindAgentModule(triage, { identity: 'other' })).toThrow(
			'already bound to identity "triage" and cannot be rebound as "other"',
		);
	});

	it('validates the identity charset', () => {
		expect(() => __flueBindAgentModule(testAgent(), { identity: 'a:b' })).toThrow(
			'must be non-empty and must not contain ":"',
		);
	});

	it('does not add the module to the registered application set', () => {
		__flueBindAgentModule(testAgent(), { identity: 'triage' });
		expect(getRegisteredFlueAgents()).toEqual([]);
	});
});
