import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import { InvalidRequestError } from '../src/errors.ts';
import {
	assertRenderStructureInvariance,
	renderAgentFunction,
	renderAgentFunctionWithStructure,
} from '../src/hooks/render.ts';
import { useInstruction } from '../src/hooks/use-instruction.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { usePersistentState } from '../src/hooks/use-persistent-state.ts';
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
			useModel(model);
			useInstruction('First contribution.');
			useInstruction('Second contribution.');
			return 'Base identity instruction.';
		}

		const systemPrompt = await processPromptCapturingSystemPrompt(defineAgent(Writer), provider);

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
			useModel(model);
			useHouseVoice();
			return 'Base.';
		}

		const systemPrompt = await processPromptCapturingSystemPrompt(defineAgent(Writer), provider);

		expect(systemPrompt).toContain('Write in the house voice.');
	});

	it('resolves a registered function agent through dispatch()', async () => {
		const admitted: DispatchInput[] = [];
		const moderator = defineAgent(() => {
			useModel(MODEL);
		});
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
		const writer = defineAgent(() => 'Writer.');
		expect(() => registerFlueAgents([{ identity: 'writer', definition: writer }])).not.toThrow();
		expect(() => registerFlueAgents([{ identity: 'broken', definition: {} as never }])).toThrow(
			'must default-export defineAgent(Agent)',
		);
	});

	it('rejects a bare capability function module value with a wrap hint', () => {
		function Support() {
			return 'Support.';
		}
		expect(() =>
			registerFlueAgents([{ identity: 'support', definition: Support as never }]),
		).toThrow('defineAgent(Support)');
	});
});

describe('defineAgent(Capability)', () => {
	it('requires a function', () => {
		expect(() => defineAgent('not a function' as never)).toThrow('requires a function');
	});

	it('produces a frozen, marked value with a route factory', () => {
		const agent = defineAgent(() => 'x');
		expect(agent.__flueFunctionAgent).toBe(true);
		expect(Object.isFrozen(agent)).toBe(true);
		expect(typeof agent.route).toBe('function');
	});
});

describe('renderAgentFunction()', () => {
	it('maps useModel + returned instruction onto the runtime config shape', () => {
		const config = renderAgentFunction(() => {
			useModel(MODEL, { thinkingLevel: 'low', compaction: false });
			return 'Base.';
		});

		expect(config).toEqual({
			model: MODEL,
			instructions: 'Base.',
			thinkingLevel: 'low',
			compaction: false,
		});
	});

	it('omits instructions entirely when neither return nor contributions exist', () => {
		expect(
			renderAgentFunction(() => {
				useModel(MODEL);
			}),
		).toEqual({ model: MODEL });
	});

	it('appends contributions without a returned instruction', () => {
		const config = renderAgentFunction(() => {
			useInstruction('Only contribution.');
		});
		expect(config.instructions).toBe('Only contribution.');
	});

	it('rejects an object return', () => {
		expect(() =>
			renderAgentFunction(() => ({ model: MODEL, instruction: 'Base.' }) as never),
		).toThrow('An agent returns its instruction string');
	});

	it('rejects an async agent capability', () => {
		const asyncAgent = (async () => 'Base.') as never;
		expect(() => renderAgentFunction(asyncAgent)).toThrow('must be synchronous');
	});

	it('clears the frame after a render that throws', () => {
		expect(() =>
			renderAgentFunction(() => {
				throw new Error('render exploded');
			}),
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
			renderAgentFunction(() => {
				useInstruction('   ');
			}),
		).toThrow('requires a non-empty string');
	});
});

describe('custom hooks (composition)', () => {
	const tool = (name: string) => ({
		name,
		description: `The ${name} tool.`,
		run: async () => 'ok',
	});

	it("lands a custom hook's useTool/useInstruction flat on the render, in call order after the base instruction", () => {
		function useRetention() {
			useTool(tool('offer_credit'));
			useInstruction('Prefer the smallest credit that resolves the concern.');
		}
		const config = renderAgentFunction(() => {
			useInstruction('Ungrouped note.');
			useRetention();
			return 'Base.';
		});

		const doc = config.instructions ?? '';
		const order = ['Base.', 'Ungrouped note.', 'Prefer the smallest credit that resolves the concern.'].map(
			(part) => doc.indexOf(part),
		);
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(config.tools?.map((t) => t.name)).toEqual(['offer_credit']);
	});

	it('composes nested custom hooks flat, in call order', () => {
		function useInner() {
			useInstruction('Inner contribution.');
		}
		function useOuter() {
			useInner();
			useInstruction('Outer contribution.');
		}
		const config = renderAgentFunction(() => {
			useOuter();
			return 'Base.';
		});
		const doc = config.instructions ?? '';
		const base = doc.indexOf('Base.');
		const inner = doc.indexOf('Inner contribution.');
		const outer = doc.indexOf('Outer contribution.');
		expect(base).toBeGreaterThanOrEqual(0);
		expect(inner).toBeGreaterThan(base);
		expect(outer).toBeGreaterThan(inner);
	});

	it('takes arguments and returns values to the agent body', () => {
		function usePhase({ check, onComplete }: { check: () => boolean; onComplete: () => string }) {
			useTool({
				name: 'begin_draft',
				description: 'Advance.',
				run: async () => (check() ? onComplete() : 'Refused.'),
			});
			return 'phase-ready';
		}
		let received: string | undefined;
		const config = renderAgentFunction(() => {
			received = usePhase({ check: () => true, onComplete: () => 'You are now drafting.' });
			return 'Gather facts.';
		});
		expect(received).toBe('phase-ready');
		expect(config.instructions).toContain('Gather facts.');
		expect(config.tools?.map((t) => t.name)).toEqual(['begin_draft']);
	});

	it('allows a custom hook that only declares resources to be called conditionally', () => {
		function useRetention() {
			useTool(tool('offer_credit'));
		}
		let mount = false;
		const agent = () => {
			if (mount) useRetention();
			return 'Base.';
		};
		const first = renderAgentFunctionWithStructure(agent).structure;
		mount = true;
		const second = renderAgentFunctionWithStructure(agent).structure;
		expect(() => assertRenderStructureInvariance(first, second)).not.toThrow();
		expect(second.resources.tools.map((t) => t.name)).toEqual(['offer_credit']);
	});
});

describe('assertRenderStructureInvariance()', () => {
	const render = (agent: () => string | undefined) =>
		renderAgentFunctionWithStructure(agent).structure;

	it('passes when consecutive renders are structurally identical', () => {
		function useRetention() {
			useInstruction('Retention.');
		}
		const agent = () => {
			useRetention();
			useTool({ name: 'lookup', description: 'Look up.', run: async () => 'ok' });
			return 'Base.';
		};
		expect(() => assertRenderStructureInvariance(render(agent), render(agent))).not.toThrow();
	});

	it('lets resources flip while a mixed custom hook still trips on its identity part', () => {
		// Resources are dynamic; identity is static. A custom hook that
		// declares BOTH inherits the stricter rule through its usePersistentState.
		function useDelegated(mounted: boolean) {
			if (!mounted) return;
			usePersistentState('delegated', null);
			useTool({ name: 'record_step', description: 'Record.', run: async () => 'ok' });
		}
		const withIt = () => {
			useDelegated(true);
			return 'Base.';
		};
		const withoutIt = () => {
			useDelegated(false);
			return 'Base.';
		};
		expect(() => assertRenderStructureInvariance(render(withoutIt), render(withIt))).toThrow(
			/state added delegated/,
		);
		expect(() => assertRenderStructureInvariance(render(withoutIt), render(withIt))).toThrow(
			/changed identity between turns/,
		);
	});

	it('reports tool changes in the resources snapshot instead of throwing', () => {
		const a = () => {
			useTool({ name: 'alpha', description: 'A.', run: async () => 'ok' });
			return undefined;
		};
		const b = () => {
			useTool({ name: 'beta', description: 'B.', run: async () => 'ok' });
			return undefined;
		};
		const first = render(a);
		const second = render(b);
		expect(() => assertRenderStructureInvariance(first, second)).not.toThrow();
		expect(first.resources.tools.map((t) => t.name)).toEqual(['alpha']);
		expect(second.resources.tools.map((t) => t.name)).toEqual(['beta']);
	});

	it('fingerprints tool descriptions so content changes surface as updates', () => {
		let flip = false;
		const agent = () => {
			useTool({
				name: 'stable',
				description: flip ? 'Second description.' : 'First description.',
				run: async () => 'ok',
			});
			return undefined;
		};
		const first = render(agent);
		flip = true;
		const second = render(agent);
		expect(() => assertRenderStructureInvariance(first, second)).not.toThrow();
		expect(first.resources.tools[0]?.description).toBe('First description.');
		expect(second.resources.tools[0]?.description).toBe('Second description.');
	});
});

describe('agent() routing helper', () => {
	it('builds a mountable router for a registered function agent', async () => {
		const writer = defineAgent(() => 'Writer.');
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
