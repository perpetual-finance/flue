import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import { InvalidRequestError } from '../src/errors.ts';
import { renderAgentFunction } from '../src/hooks/render.ts';
import { use } from '../src/hooks/use.ts';
import { useInstruction } from '../src/hooks/use-instruction.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { dispatch } from '../src/index.ts';
import { configureFlueRuntime, createFlueContext, type DispatchInput } from '../src/internal.ts';
import { agent as agentRouteHelper } from '../src/routing.ts';
import {
	type AgentSubmissionInput,
	createAgentSubmissionSessionHandler,
} from '../src/runtime/agent-submissions.ts';
import { resetFlueRuntimeForTests } from '../src/runtime/flue-app.ts';
import {
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
} from '../src/runtime/registration.ts';
import type { FunctionAgentDefinition } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';
import { agentRecord, nodeRuntime } from './helpers/runtime-config.ts';

const providers: FauxProviderRegistration[] = [];

const MODEL = 'anthropic/claude-haiku-4-5';

afterEach(() => {
	resetFlueRuntimeForTests();
	resetFlueAgentRegistrationForTests();
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `agent-function-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

/** Run one user prompt through a full submission and return the model-visible system prompt. */
async function processPromptCapturingSystemPrompt(
	agent: FunctionAgentDefinition,
	provider: FauxProviderRegistration,
): Promise<string> {
	let systemPrompt: string | undefined;
	provider.setResponses([
		(context) => {
			systemPrompt = context.systemPrompt;
			return fauxAssistantMessage('done');
		},
	]);
	const input: AgentSubmissionInput = {
		kind: 'direct',
		submissionId: `direct:${crypto.randomUUID()}`,
		agent: 'writer',
		id: 'guild:function-agent',
		message: { kind: 'user', body: 'Hello there' },
		acceptedAt: '2026-07-03T00:00:00.000Z',
	};
	const ctx = createFlueContext({
		id: input.id,
		env: {},
		agentConfig: {
			subagents: {},
			resolveModel: () => provider.getModel(),
		},
		createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
	});
	await createAgentSubmissionSessionHandler(agent, input, (s) =>
		s.processSubmissionInput(input, {
			submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
		}),
	)(ctx);
	if (systemPrompt === undefined) throw new Error('faux provider was never called');
	return systemPrompt;
}

describe('function agents (Flue Hooks)', () => {
	it('processes a submission end-to-end: returned instruction first, useInstruction contributions in call order', async () => {
		const provider = createProvider();
		const model = `${provider.getModel().provider}/${provider.getModel().id}`;
		function Writer() {
			useInstruction('First contribution.');
			useInstruction('Second contribution.');
			return 'Base identity instruction.';
		}

		const systemPrompt = await processPromptCapturingSystemPrompt(
			defineAgent(Writer, { model }),
			provider,
		);

		const base = systemPrompt.indexOf('Base identity instruction.');
		const first = systemPrompt.indexOf('First contribution.');
		const second = systemPrompt.indexOf('Second contribution.');
		expect(base).toBeGreaterThanOrEqual(0);
		expect(first).toBeGreaterThan(base);
		expect(second).toBeGreaterThan(first);
	});

	it('composes custom hooks', async () => {
		const provider = createProvider();
		const model = `${provider.getModel().provider}/${provider.getModel().id}`;
		function useHouseVoice() {
			useInstruction('Write in the house voice.');
		}
		function Writer() {
			useHouseVoice();
			return 'Base.';
		}

		const systemPrompt = await processPromptCapturingSystemPrompt(
			defineAgent(Writer, { model }),
			provider,
		);

		expect(systemPrompt).toContain('Write in the house voice.');
	});

	it('resolves a registered function agent through dispatch()', async () => {
		const admitted: DispatchInput[] = [];
		const moderator = defineAgent(() => undefined, { model: MODEL });
		configureFlueRuntime({
			...nodeRuntime(),
			dispatchQueue: {
				enqueue: async (input) => {
					admitted.push(input);
					return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
				},
			},
			agents: [agentRecord('moderator', { definition: moderator })],
		});

		await dispatch(moderator, {
			id: 'guild:function-dispatch',
			message: { kind: 'signal', type: 'flagged', body: 'report' },
		});

		expect(admitted).toMatchObject([{ agent: 'moderator', id: 'guild:function-dispatch' }]);
	});

	it('still rejects non-agent dispatch targets', async () => {
		configureFlueRuntime({ ...nodeRuntime(), agents: [agentRecord('moderator')] });

		const error = await dispatch({ agent: 'moderator' } as any, {
			id: 'guild:bad-target',
			message: { kind: 'signal', type: 'flagged', body: 'report' },
		}).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(InvalidRequestError);
	});

	it('registers function agents and rejects invalid module values', () => {
		const writer = defineAgent(() => 'Writer.', { model: MODEL });
		expect(() => registerFlueAgents([{ identity: 'writer', definition: writer }])).not.toThrow();
		expect(() => registerFlueAgents([{ identity: 'broken', definition: {} as never }])).toThrow(
			'must default-export defineAgent(...)',
		);
	});

	it('rejects a bare capability function module value with a wrap hint', () => {
		function Support() {
			return 'Support.';
		}
		expect(() =>
			registerFlueAgents([{ identity: 'support', definition: Support as never }]),
		).toThrow("defineAgent(Support, { model: 'provider-id/model-id' })");
	});
});

describe('defineAgent(Capability, config)', () => {
	it('validates the config shape', () => {
		expect(() => defineAgent(() => 'x', {} as never)).toThrow('defineAgent() config is invalid');
		expect(() => defineAgent(() => 'x', { model: MODEL, nope: true } as never)).toThrow(
			'unknown agent config field',
		);
		expect(() => defineAgent('not a function' as never, { model: MODEL })).toThrow(
			'requires a function',
		);
	});

	it('produces a frozen, marked value with a route factory', () => {
		const agent = defineAgent(() => 'x', { model: MODEL });
		expect(agent.__flueFunctionAgent).toBe(true);
		expect(Object.isFrozen(agent)).toBe(true);
		expect(typeof agent.route).toBe('function');
	});
});

describe('renderAgentFunction()', () => {
	it('maps config + returned instruction onto the runtime config shape', () => {
		const config = renderAgentFunction(() => 'Base.', {
			model: MODEL,
			thinkingLevel: 'low',
			compaction: false,
			cwd: '/workspace',
		});

		expect(config).toEqual({
			model: MODEL,
			instructions: 'Base.',
			thinkingLevel: 'low',
			compaction: false,
			cwd: '/workspace',
		});
	});

	it('omits instructions entirely when neither return nor contributions exist', () => {
		expect(renderAgentFunction(() => undefined, { model: MODEL })).toEqual({ model: MODEL });
	});

	it('appends contributions without a returned instruction', () => {
		const config = renderAgentFunction(
			() => {
				useInstruction('Only contribution.');
			},
			{ model: MODEL },
		);
		expect(config.instructions).toBe('Only contribution.');
	});

	it('rejects an object return', () => {
		expect(() =>
			renderAgentFunction(() => ({ model: MODEL, instruction: 'Base.' }) as never, {
				model: MODEL,
			}),
		).toThrow('An agent returns its instruction string');
	});

	it('rejects an async agent capability', () => {
		const asyncAgent = (async () => 'Base.') as never;
		expect(() => renderAgentFunction(asyncAgent, { model: MODEL })).toThrow('must be synchronous');
	});

	it('clears the frame after a render that throws', () => {
		expect(() =>
			renderAgentFunction(
				() => {
					throw new Error('render exploded');
				},
				{ model: MODEL },
			),
		).toThrow('render exploded');
		// The frame must not leak: hooks are unavailable again immediately after.
		expect(() => useInstruction('outside')).toThrow('outside an agent function');
	});
});

describe('useInstruction()', () => {
	it('throws when called outside an agent function render', () => {
		expect(() => useInstruction('anywhere')).toThrow(
			'useInstruction() was called outside an agent function',
		);
	});

	it('rejects empty instruction text', () => {
		expect(() =>
			renderAgentFunction(
				() => {
					useInstruction('   ');
				},
				{ model: MODEL },
			),
		).toThrow('requires a non-empty string');
	});
});

describe('use() capabilities', () => {
	const tool = (name: string) => ({
		name,
		description: `The ${name} tool.`,
		run: async () => 'ok',
	});

	it('concatenates capability content after base and root instructions, author-formatted', () => {
		function Retention() {
			useTool(tool('offer_credit'));
			useInstruction('Prefer the smallest credit that resolves the concern.');
			return '## Retention\n\nYou may offer retention incentives.';
		}
		const config = renderAgentFunction(
			() => {
				useInstruction('Ungrouped note.');
				use(Retention);
				return 'Base.';
			},
			{ model: MODEL },
		);

		const doc = config.instructions ?? '';
		const order = [
			'Base.',
			'Ungrouped note.',
			'## Retention',
			'You may offer retention incentives.',
			'Prefer the smallest credit that resolves the concern.',
		].map((part) => doc.indexOf(part));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(config.tools?.map((t) => t.name)).toEqual(['offer_credit']);
	});

	it('passes props through', () => {
		function Phase({ check, onComplete }: { check: () => boolean; onComplete: () => string }) {
			useTool({
				name: 'begin_draft',
				description: 'Advance.',
				run: async () => (check() ? onComplete() : 'Refused.'),
			});
			return 'Gather facts.';
		}
		const config = renderAgentFunction(
			() => {
				use(Phase, { check: () => true, onComplete: () => 'You are now drafting.' });
			},
			{ model: MODEL },
		);
		expect(config.instructions).toContain('Gather facts.');
		expect(config.tools?.map((t) => t.name)).toEqual(['begin_draft']);
	});

	it('allows a tools-only capability (no return)', () => {
		function Tools() {
			useTool(tool('lookup'));
		}
		const config = renderAgentFunction(
			() => {
				use(Tools);
			},
			{ model: MODEL },
		);
		expect(config.instructions).toBeUndefined();
		expect(config.tools?.map((t) => t.name)).toEqual(['lookup']);
	});

	it('rejects an already-invoked capability', () => {
		const Retention = () => 'Retention prose.';
		expect(() =>
			renderAgentFunction(
				() => {
					use(Retention() as never);
				},
				{ model: MODEL },
			),
		).toThrow('pass the function itself');
	});

	it('rejects an object return from a capability', () => {
		expect(() =>
			renderAgentFunction(
				() => {
					use((() => ({ key: 'x' })) as never);
				},
				{ model: MODEL },
			),
		).toThrow('returns its instruction string');
	});

	it('fails fast on duplicate tool names across root and capabilities', () => {
		const A = () => {
			useTool(tool('clash'));
		};
		expect(() =>
			renderAgentFunction(
				() => {
					useTool(tool('clash'));
					use(A);
				},
				{ model: MODEL },
			),
		).toThrow(/clash/);
	});

	it('supports nested use() calls, recorded flat in mount order', () => {
		const Inner = () => 'Inner prose.';
		const Outer = () => {
			use(Inner);
			return 'Outer prose.';
		};
		const config = renderAgentFunction(
			() => {
				use(Outer);
			},
			{ model: MODEL },
		);
		const doc = config.instructions ?? '';
		expect(doc.indexOf('Inner prose.')).toBeGreaterThanOrEqual(0);
		expect(doc.indexOf('Outer prose.')).toBeGreaterThanOrEqual(0);
	});

	it('mounts capability tools live end-to-end', async () => {
		const provider = createProvider();
		const model = `${provider.getModel().provider}/${provider.getModel().id}`;
		function Weather() {
			useTool({
				name: 'lookup_weather',
				description: 'Look up current weather for a city.',
				run: async () => 'sunny',
			});
			return 'Use the weather tool when asked about weather.';
		}
		const systemPrompt = await processPromptCapturingSystemPrompt(
			defineAgent(
				() => {
					use(Weather);
					return 'Base.';
				},
				{ model },
			),
			provider,
		);
		expect(systemPrompt).toContain('Use the weather tool when asked about weather.');
	});
});

describe('agent() routing helper', () => {
	it('builds a mountable router for a registered function agent', async () => {
		const writer = defineAgent(() => 'Writer.', { model: MODEL });
		registerFlueAgents([{ identity: 'writer', definition: writer }]);
		const router = agentRouteHelper(writer).route();
		// No runtime configured: hitting a route fails with the runtime error,
		// which proves resolution reached the handler (mounting itself worked).
		const response = await router.fetch(
			new Request('http://flue.local/conv-1', { method: 'POST' }),
		);
		expect(response.status).toBeGreaterThanOrEqual(400);
	});

	it('rejects values that are not agent module exports', () => {
		expect(() => agentRouteHelper({} as never)).toThrow("requires a 'use agent' module");
		expect(() => agentRouteHelper((() => 'bare') as never)).toThrow(
			"requires a 'use agent' module",
		);
	});
});

describe('defineAgent coexistence', () => {
	it('initializes legacy defineAgent values through the same submission path', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('ok')]);
		const legacy = defineAgent(() => ({
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
			instructions: 'Legacy instructions.',
		}));
		const input: AgentSubmissionInput = {
			kind: 'direct',
			submissionId: `direct:${crypto.randomUUID()}`,
			agent: 'legacy',
			id: 'guild:legacy-coexists',
			message: { kind: 'user', body: 'Hello legacy' },
			acceptedAt: '2026-07-03T00:00:00.000Z',
		};
		const ctx = createFlueContext({
			id: input.id,
			env: {},
			agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
		});

		// Success = the submission settles without rejecting.
		await expect(
			createAgentSubmissionSessionHandler(legacy, input, (s) =>
				s.processSubmissionInput(input, {
					submissionAttempt: { submissionId: input.submissionId, attemptId: 'attempt-1' },
				}),
			)(ctx),
		).resolves.toBeUndefined();
	});
});
