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
import type { AgentFunction, AgentManifest } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';
import { agentRecord, nodeRuntime } from './helpers/runtime-config.ts';

const providers: FauxProviderRegistration[] = [];

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
	agent: AgentFunction,
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

describe('agent functions (Flue Hooks)', () => {
	it('processes a submission end-to-end with base instruction and useInstruction contributions in call order', async () => {
		const provider = createProvider();
		const model = `${provider.getModel().provider}/${provider.getModel().id}`;
		function writer(): AgentManifest {
			useInstruction('First contribution.');
			useInstruction('Second contribution.');
			return { model, instruction: 'Base identity instruction.' };
		}

		const systemPrompt = await processPromptCapturingSystemPrompt(writer, provider);

		const base = systemPrompt.indexOf('Base identity instruction.');
		const first = systemPrompt.indexOf('First contribution.');
		const second = systemPrompt.indexOf('Second contribution.');
		expect(base).toBeGreaterThanOrEqual(0);
		expect(first).toBeGreaterThan(base);
		expect(second).toBeGreaterThan(first);
	});

	it('composes custom hooks and conditional contributions', async () => {
		const provider = createProvider();
		const model = `${provider.getModel().provider}/${provider.getModel().id}`;
		function useHouseVoice() {
			useInstruction('Write in the house voice.');
		}
		function writer(): AgentManifest {
			useHouseVoice();
			if ((globalThis as { __unset?: boolean }).__unset) {
				useInstruction('Never mounted.');
			}
			return { model, instruction: 'Base.' };
		}

		const systemPrompt = await processPromptCapturingSystemPrompt(writer, provider);

		expect(systemPrompt).toContain('Write in the house voice.');
		expect(systemPrompt).not.toContain('Never mounted.');
	});

	it('resolves a registered agent function through dispatch()', async () => {
		const admitted: DispatchInput[] = [];
		const moderator: AgentFunction = () => ({ model: 'anthropic/claude-haiku-4-5' });
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

	it('registers agent functions and keeps rejecting invalid module values', () => {
		const writer: AgentFunction = () => ({ model: 'anthropic/claude-haiku-4-5' });
		expect(() => registerFlueAgents([{ identity: 'writer', definition: writer }])).not.toThrow();
		expect(() => registerFlueAgents([{ identity: 'broken', definition: {} as never }])).toThrow(
			'must default-export an agent function or defineAgent(...)',
		);
	});
});

describe('renderAgentFunction()', () => {
	it('maps the manifest onto the runtime config shape', () => {
		const config = renderAgentFunction(() => ({
			model: 'anthropic/claude-haiku-4-5',
			instruction: 'Base.',
			thinkingLevel: 'low',
			compaction: false,
			cwd: '/workspace',
		}));

		expect(config).toEqual({
			model: 'anthropic/claude-haiku-4-5',
			instructions: 'Base.',
			thinkingLevel: 'low',
			compaction: false,
			cwd: '/workspace',
		});
	});

	it('omits instructions entirely when neither base nor contributions exist', () => {
		expect(renderAgentFunction(() => ({ model: 'anthropic/claude-haiku-4-5' }))).toEqual({
			model: 'anthropic/claude-haiku-4-5',
		});
	});

	it('appends contributions without a base instruction', () => {
		const config = renderAgentFunction(() => {
			useInstruction('Only contribution.');
			return { model: 'anthropic/claude-haiku-4-5' };
		});
		expect(config.instructions).toBe('Only contribution.');
	});

	it('rejects unknown manifest fields', () => {
		expect(() => renderAgentFunction(() => ({ instructions: 'plural' }) as never)).toThrow(
			'unknown agent manifest field',
		);
	});

	it('rejects a string return (no terminal replies)', () => {
		expect(() => renderAgentFunction(() => 'done' as never)).toThrow(
			'returning a string is not supported',
		);
	});

	it('rejects an async agent function', () => {
		const asyncAgent = (async () => ({ model: 'anthropic/claude-haiku-4-5' })) as never;
		expect(() => renderAgentFunction(asyncAgent)).toThrow('must be synchronous');
	});

	it('rejects a missing manifest', () => {
		expect(() => renderAgentFunction((() => undefined) as never)).toThrow(
			'must return a manifest object',
		);
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
				return { model: 'anthropic/claude-haiku-4-5' };
			}),
		).toThrow('requires a non-empty string');
	});
});

describe('use() components', () => {
	const tool = (name: string) => ({
		name,
		description: `The ${name} tool.`,
		run: async () => 'ok',
	});

	it('renders components as capability sections after base and ungrouped instructions', () => {
		function Retention() {
			useTool(tool('offer_credit'));
			useInstruction('Prefer the smallest credit that resolves the concern.');
			return {
				key: 'retention',
				description: 'Offer retention incentives when the customer is weighing cancellation.',
				instruction: 'You may offer retention incentives.',
			};
		}
		const config = renderAgentFunction(() => {
			useInstruction('Ungrouped note.');
			use(Retention);
			return { model: 'anthropic/claude-haiku-4-5', instruction: 'Base.' };
		});

		const doc = config.instructions ?? '';
		const order = [
			'Base.',
			'Ungrouped note.',
			'# Capabilities',
			'## retention',
			'Offer retention incentives when the customer is weighing cancellation.',
			'You may offer retention incentives.',
			'Prefer the smallest credit that resolves the concern.',
			'Tools: offer_credit',
		].map((part) => doc.indexOf(part));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		expect(config.tools?.map((t) => t.name)).toEqual(['offer_credit']);
	});

	it('passes props through and mounts conditionally', () => {
		function Phase({ next }: { next: () => void }) {
			useTool({
				name: 'begin_draft',
				description: 'Advance.',
				run: async () => {
					next();
					return 'ok';
				},
			});
			return { key: 'phase/gathering', instruction: 'Gather facts.' };
		}
		const config = renderAgentFunction(() => {
			const phase = 'gathering' as string;
			if (phase === 'gathering') use(Phase, { next: () => {} });
			if (phase === 'drafting') use(Phase, { next: () => {} });
			return { model: 'anthropic/claude-haiku-4-5' };
		});
		expect(config.instructions).toContain('## phase/gathering');
		expect(config.tools?.map((t) => t.name)).toEqual(['begin_draft']);
	});

	it('rejects a duplicate component key in one render', () => {
		const Dup = () => ({ key: 'dup' });
		expect(() =>
			renderAgentFunction(() => {
				use(Dup);
				use(Dup);
				return { model: 'anthropic/claude-haiku-4-5' };
			}),
		).toThrow('Duplicate component key "dup"');
	});

	it('rejects an already-invoked component', () => {
		const Retention = () => ({ key: 'retention' });
		expect(() =>
			renderAgentFunction(() => {
				use(Retention() as never);
				return { model: 'anthropic/claude-haiku-4-5' };
			}),
		).toThrow('pass the function itself');
	});

	it('rejects invalid component manifests', () => {
		expect(() =>
			renderAgentFunction(() => {
				use((() => ({ key: 'x', tools: [] })) as never);
				return { model: 'anthropic/claude-haiku-4-5' };
			}),
		).toThrow('unknown component manifest field');
		expect(() =>
			renderAgentFunction(() => {
				use((() => undefined) as never);
				return { model: 'anthropic/claude-haiku-4-5' };
			}),
		).toThrow('must return a manifest object');
	});

	it('fails fast on duplicate tool names across root and components', () => {
		const A = () => {
			useTool(tool('clash'));
			return { key: 'a' };
		};
		expect(() =>
			renderAgentFunction(() => {
				useTool(tool('clash'));
				use(A);
				return { model: 'anthropic/claude-haiku-4-5' };
			}),
		).toThrow(/clash/);
	});

	it('supports nested use() calls, recorded flat', () => {
		const Inner = () => ({ key: 'inner', instruction: 'Inner prose.' });
		const Outer = () => {
			use(Inner);
			return { key: 'outer', instruction: 'Outer prose.' };
		};
		const config = renderAgentFunction(() => {
			use(Outer);
			return { model: 'anthropic/claude-haiku-4-5' };
		});
		expect(config.instructions).toContain('## outer');
		expect(config.instructions).toContain('## inner');
	});

	it('mounts component tools live end-to-end', async () => {
		const provider = createProvider();
		const model = `${provider.getModel().provider}/${provider.getModel().id}`;
		function Weather() {
			useTool({
				name: 'lookup_weather',
				description: 'Look up current weather for a city.',
				run: async () => 'sunny',
			});
			return { key: 'weather', instruction: 'Use the weather tool when asked about weather.' };
		}
		const systemPrompt = await processPromptCapturingSystemPrompt(() => {
			use(Weather);
			return { model, instruction: 'Base.' };
		}, provider);
		expect(systemPrompt).toContain('## weather');
		expect(systemPrompt).toContain('Tools: lookup_weather');
	});
});

describe('agent() routing helper', () => {
	it('builds a mountable router for a registered agent function', async () => {
		const writer: AgentFunction = () => ({ model: 'anthropic/claude-haiku-4-5' });
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
	});

	it('throws at route() for an unbound agent function', () => {
		const stray: AgentFunction = () => ({ model: 'anthropic/claude-haiku-4-5' });
		expect(() => agentRouteHelper(stray).route()).toThrow('requires an agent identity');
	});
});

describe('defineAgent coexistence', () => {
	it('initializes defineAgent values through the same submission path', async () => {
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
