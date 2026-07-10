import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import type { Harness } from '../src/harness.ts';
import { renderAgentFunctionWithStructure } from '../src/hooks/render.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { usePersistentState } from '../src/hooks/use-persistent-state.ts';
import { useSandbox } from '../src/hooks/use-sandbox.ts';
import { useSubagent } from '../src/hooks/use-subagent.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import { observe } from '../src/runtime/events.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { defineTool } from '../src/tool.ts';
import type { SessionEnv } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];
const tempDirs: string[] = [];
const unsubscribers: Array<() => void> = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
	for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true });
		} catch {}
	}
});

function createFauxProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `agent-harness-tool-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-harness-tool-'));
	tempDirs.push(dir);
	return join(dir, 'agent.db');
}

function makeFauxCreateContext(provider: FauxProviderRegistration): CreateAgentContextFn {
	return ({ id, request, initialEventIndex, dispatchId }) =>
		createFlueContext({
			id,
			dispatchId,
			env: {},
			req: request,
			initialEventIndex,
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
		});
}

function makeDispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: `dispatch-${crypto.randomUUID()}`,
		agent: 'assistant',
		id: 'instance-1',
		message: { kind: 'signal', type: 'test.event', body: 'Hello' },
		acceptedAt: new Date().toISOString(),
		...overrides,
	};
}

async function connectSqlite(dbPath: string) {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	return adapter.connect();
}

/** A root harness without the sqlite-backed coordinator, for tests that only
 * need one session's worth of direct prompting (mirrors the pattern used in
 * tool.test.ts / harness-session.test.ts). */
function createDirectContext(provider: FauxProviderRegistration, env: SessionEnv = createNoopSessionEnv()) {
	return createFlueContext({
		id: 'agent-harness-tool-direct-instance',
		env: {},
		agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
		createDefaultEnv: async () => env,
	});
}

const CONFIG = { model: 'faux/agent-harness-tool' };

describe('defineTool({ harness })', () => {
	it('accepts the flag and keeps it on the frozen definition', () => {
		const tool = defineTool({
			name: 'connected',
			description: 'Runtime-connected tool.',
			harness: true,
			run: ({ harness }) => harness.sandbox.exec('pwd').then((result) => result.stdout),
		});
		expect(tool.harness).toBe(true);
	});

	it('rejects non-boolean harness values', () => {
		expect(() =>
			defineTool({
				name: 'broken',
				description: 'Bad flag.',
				// @ts-expect-error harness must be a boolean
				harness: 'yes',
				run: () => 'nope',
			}),
		).toThrow(/harness must be a boolean/);
	});

	it('mounts through useTool with the flag preserved', () => {
		const rendered = renderAgentFunctionWithStructure(() => {
			useModel(CONFIG.model);
			useTool({
				name: 'connected',
				description: 'Runtime-connected tool.',
				harness: true,
				run: ({ harness }) => harness.sandbox.exec('pwd').then((result) => result.stdout),
			});
			return 'Base.';
		});
		expect(rendered.config.tools?.[0]?.harness).toBe(true);
	});
});

describe('harness tools end to end (node coordinator, faux provider)', () => {
	it('gives harness tools model access, logs for every tool, and retention keyed on the tool call id', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();

		provider.setResponses([
			// Parent turn 1: the plain tool.
			fauxAssistantMessage(fauxToolCall('pure_probe', {}, { id: 'tool-pure-1' }), {
				stopReason: 'toolUse',
			}),
			// Parent turn 2: the harness tool.
			fauxAssistantMessage(
				fauxToolCall('ask_model', { question: 'What is the summary?' }, { id: 'tool-ask-1' }),
				{ stopReason: 'toolUse' },
			),
			// Child turn: the prompt made by ask_model's harness session.
			fauxAssistantMessage('CHILD-ANSWER'),
			// Parent turn 3: done.
			fauxAssistantMessage('Done.'),
		]);

		const logEvents: Array<{ message: string; attributes?: Record<string, unknown> }> = [];
		unsubscribers.push(
			observe((observation) => {
				if (observation.type === 'log') {
					logEvents.push({ message: observation.message, attributes: observation.attributes });
				}
			}),
		);

		let pureContextKeys: string[] | undefined;
		let harnessAnswer: string | undefined;
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useTool({
				name: 'pure_probe',
				description: 'A tool without runtime access.',
				input: v.object({}),
				run: (ctx) => {
					pureContextKeys = Object.keys(ctx).sort();
					ctx.log.info('probe ran', { marker: 'pure' });
					return 'probed';
				},
			});
			useTool({
				name: 'ask_model',
				description: 'Ask a model through the harness.',
				input: v.object({ question: v.string() }),
				harness: true,
				run: async ({ data, harness, log }) => {
					log.info('asking', { question: data.question });
					const response = await harness.prompt(data.question);
					harnessAnswer = response.text;
					return response.text;
				},
			});
			return 'Case agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant),
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:harness-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// Plain tools: log + signal, no harness surface.
		expect(pureContextKeys).toEqual(['data', 'log', 'signal']);
		// The harness tool drove a real child model call.
		expect(harnessAnswer).toBe('CHILD-ANSWER');
		// ctx.log streams for BOTH kinds of tool, attributed to the call.
		expect(logEvents).toContainEqual({
			message: 'probe ran',
			attributes: { marker: 'pure', tool: 'pure_probe', toolCallId: 'tool-pure-1' },
		});
		expect(logEvents).toContainEqual({
			message: 'asking',
			attributes: { question: 'What is the summary?', tool: 'ask_model', toolCallId: 'tool-ask-1' },
		});
		// The child conversation the harness opened was durably retained under
		// the per-attempt invocation id (inv_<ulid> — the durable contract; the
		// toolCallId correlates via the tool result's details).
		const db = new DatabaseSync(dbPath);
		const rows = db
			.prepare('SELECT data FROM flue_conversation_stream_batches')
			.all() as Array<{ data: string }>;
		db.close();
		const retained = rows.filter((row) => row.data.includes('child_session_retained'));
		expect(retained.length).toBeGreaterThanOrEqual(1);
	});

	it('flattened harness.prompt drives one scratch conversation across calls (with result schemas)', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();

		let secondCallContextMessages: number | undefined;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('two_step', {}, { id: 'tool-flat-1' }), {
				stopReason: 'toolUse',
			}),
			// First harness.prompt: result schemas settle via the finish tool.
			fauxAssistantMessage(fauxToolCall('finish', { count: 1 }, { id: 'tool-flat-finish' }), {
				stopReason: 'toolUse',
			}),
			// Second harness.prompt: continuity means the scratch conversation
			// already carries the first exchange.
			(context) => {
				secondCallContextMessages = context.messages.length;
				return fauxAssistantMessage('two');
			},
			fauxAssistantMessage('Done.'),
		]);

		let structured: { count: number } | undefined;
		let followUp: string | undefined;
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useTool({
				name: 'two_step',
				description: 'Two prompts in one harness conversation.',
				harness: true,
				run: async ({ harness }) => {
					const first = await harness.prompt('Count.', {
						result: v.object({ count: v.number() }),
					});
					structured = first.data;
					const second = await harness.prompt('And again?');
					followUp = second.text;
					return 'done';
				},
			});
			return 'Call two_step.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant),
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:flat-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(structured).toEqual({ count: 1 });
		expect(followUp).toBe('two');
		// The second call's context included the first exchange (system prompt
		// + first user + first assistant + second user at minimum).
		expect(secondCallContextMessages ?? 0).toBeGreaterThanOrEqual(3);
	});

	it('supports harness tools declared inside a delegate capability', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();

		const execCommands: string[] = [];
		const createContext: CreateAgentContextFn = ({ id, request, initialEventIndex, dispatchId }) =>
			createFlueContext({
				id,
				dispatchId,
				env: {},
				req: request,
				initialEventIndex,
				agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
				createDefaultEnv: async () =>
					createNoopSessionEnv({
						cwd: '/',
						exec: async (command) => {
							execCommands.push(command);
							return { stdout: 'ok', stderr: '', exitCode: 0 };
						},
					}),
			});

		provider.setResponses([
			// Parent: delegate.
			fauxAssistantMessage(
				fauxToolCall('task', { prompt: 'Check the tree.', agent: 'checker' }, { id: 'tool:task-1' }),
				{ stopReason: 'toolUse' },
			),
			// Delegate turn 1: call its harness tool.
			fauxAssistantMessage(fauxToolCall('run_check', {}, { id: 'tool:check-1' }), {
				stopReason: 'toolUse',
			}),
			// Delegate turn 2: report.
			fauxAssistantMessage('CHECK-DONE'),
			// Parent turn 2: done.
			fauxAssistantMessage('Done.'),
		]);

		function Checker() {
			useTool({
				name: 'run_check',
				description: 'Run one check in the environment.',
				harness: true,
				run: async ({ harness }) => {
					const result = await harness.sandbox.exec('git status --porcelain');
					return result.stdout;
				},
			});
			return 'You verify the working tree.';
		}
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useSubagent({ name: 'checker', description: 'Checks the tree.', agent: Checker });
			return 'Case agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant),
				},
			],
			createContext,
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:harness-2' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(execCommands).toContain('git status --porcelain');
	});

	it('drains state writes made inside a harness tool with the tool batch', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();

		provider.setResponses([
			// Dispatch 1: write state through the harness tool.
			fauxAssistantMessage(fauxToolCall('record_note', {}, { id: 'tool:note-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Recorded.'),
			// Dispatch 2: a fresh run whose render must read the durable value.
			fauxAssistantMessage('Read.'),
		]);

		let renderedNote: string | undefined;
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			const [note, setNote] = usePersistentState('note', 'unset');
			renderedNote = note;
			useTool({
				name: 'record_note',
				description: 'Record the note durably.',
				harness: true,
				run: async ({ harness }) => {
					await harness.sandbox.exec('true');
					setNote('written');
					return 'ok';
				},
			});
			return 'Recorder.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant),
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:harness-3' }));
		await coordinator.waitForIdle();
		// Render-per-turn already sees the buffered write mid-submission; the
		// durable pin is the SECOND dispatch, whose render re-reduces the value
		// from the record log alone.
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:harness-4' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(renderedNote).toBe('written');
	});
});

// Ported from action-execution.test.ts (the Actions feature is being
// removed and that file will be deleted): these three cases cover shared
// harness machinery — task delegation inheritance, abort cascades, and
// sandbox reuse — that has no equivalent elsewhere, rewritten in
// `useTool({ harness: true })` terms.
describe('harness tool delegation and lifecycle (ported from action-execution.test.ts)', () => {
	it('inherits declared subagent capabilities through Task to a harness tool', async () => {
		const provider = createFauxProvider();
		const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
		let promptToolNames: string[] = [];
		const selectedTool = defineTool({
			name: 'selected_tool',
			description: 'Selected profile tool.',
			input: v.object({}),
			run: async () => 'selected',
		});
		function Reviewer() {
			useTool(selectedTool);
			useTool({
				name: 'inspect_task_scope',
				description: 'Inspect the selected task scope.',
				harness: true,
				run: async ({ harness }) => {
					await harness.sandbox.exec('pwd');
					await harness.prompt('List inherited capabilities.');
					return undefined;
				},
			});
			return 'You review the delegated scope.';
		}
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useSubagent({
				name: 'reviewer',
				description: 'Reviews the delegated scope.',
				agent: Reviewer,
			});
			return 'Case agent.';
		}
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall('task', {
					prompt: 'Inspect the task scope.',
					agent: 'reviewer',
					cwd: 'packages/runtime',
				}),
				{ stopReason: 'toolUse' },
			),
			fauxAssistantMessage(fauxToolCall('inspect_task_scope', {}), { stopReason: 'toolUse' }),
			(context) => {
				promptToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage('Capabilities inherited.');
			},
			fauxAssistantMessage('Task complete.'),
			fauxAssistantMessage('Root complete.'),
		]);
		const harness = await createDirectContext(
			provider,
			createNoopSessionEnv({ exec }),
		).initializeRootHarness(
			defineAgent(assistant),
		);

		await (await harness.session()).prompt('Delegate inspection.');

		expect(exec).toHaveBeenCalledWith(
			'pwd',
			expect.objectContaining({ cwd: '/repo/packages/runtime' }),
		);
		expect(promptToolNames).toContain('selected_tool');
		expect(promptToolNames).toContain('inspect_task_scope');
	});

	// `harness.sandbox.exec()` is the raw, untracked SessionEnv — unlike the
	// old flattened harness.shell(), it carries no implicit AbortSignal and
	// isn't awaited by the harness's own close(). The cancel-on-close cascade
	// this test pins now only applies to session-backed operations, so it
	// drives the shell call through a harness-opened session instead of the
	// harness directly.
	it("cancels a harness tool's session shell call and waits for cleanup before the tool settles", async () => {
		const provider = createFauxProvider();
		let startedResolve: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		let settled = false;
		let receivedSignal: AbortSignal | undefined;
		const env = createNoopSessionEnv({
			exec: async (_command, options) => {
				receivedSignal = options?.signal;
				startedResolve();
				if (!options?.signal?.aborted) {
					await new Promise<void>((resolve) =>
						options?.signal?.addEventListener('abort', () => resolve()),
					);
				}
				throw new DOMException('aborted', 'AbortError');
			},
		});
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useTool({
				name: 'run_direct_shell',
				description: 'Run a direct harness shell call.',
				harness: true,
				run: async ({ harness }) => {
					// Named sessions are internal machinery now (the public surface
					// is `harness.sandbox` plus the flattened default-session ops);
					// this test pins the cancel-on-close cascade for a harness-opened
					// session, so it reaches through to the class the same way the
					// "retains child sessions..." test below does.
					const internal = harness as unknown as Harness;
					const session = await internal.session();
					void session.shell('wait').then(
						() => {
							settled = true;
						},
						() => {
							settled = true;
						},
					);
					await started;
					throw new Error('finish tool');
				},
			});
			return 'Case agent.';
		}
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('run_direct_shell', {}), { stopReason: 'toolUse' }),
			(_context) => {
				expect(settled).toBe(true);
				return fauxAssistantMessage('Handled.');
			},
		]);
		const harness = await createDirectContext(provider, env).initializeRootHarness(
			defineAgent(assistant),
		);

		await (await harness.session()).prompt('Run shell.');

		expect(receivedSignal?.aborted).toBe(true);
		expect(settled).toBe(true);
	});

	it('retains child sessions and cancels every active harness-tool operation when the parent is aborted', async () => {
		const provider = createFauxProvider();
		let startedResolve: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const signals: AbortSignal[] = [];
		const env = createNoopSessionEnv({
			exec: async (_command, options) => {
				if (options?.signal) signals.push(options.signal);
				if (signals.length === 2) startedResolve();
				if (!options?.signal?.aborted) {
					await new Promise<void>((resolve) =>
						options?.signal?.addEventListener('abort', () => resolve()),
					);
				}
				throw new DOMException('aborted', 'AbortError');
			},
		});
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useTool({
				name: 'wait_for_children',
				description: 'Wait for child operations.',
				harness: true,
				run: async ({ harness }) => {
					// Named sessions are internal machinery now (the public surface
					// is the flattened default-session ops); this test pins the
					// wait-for-children behavior across parallel sessions, so it
					// reaches through to the class.
					const internal = harness as unknown as Harness;
					const first = await internal.session();
					const second = await internal.session('second');
					const calls = [first.shell('first'), second.shell('second')];
					await Promise.all(calls);
					return undefined;
				},
			});
			return 'Case agent.';
		}
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('wait_for_children', {}), { stopReason: 'toolUse' }),
		]);
		const harness = await createDirectContext(provider, env).initializeRootHarness(
			defineAgent(assistant),
		);
		const parent = await harness.session();

		const operation = parent.prompt('Wait.');
		await Promise.race([
			started,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`started ${signals.length} harness-tool operations`)), 1_000),
			),
		]);
		operation.abort('stop');

		await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});

	it('reuses the agent sandbox for a harness tool without creating a second one', async () => {
		const provider = createFauxProvider();
		const writeFile = vi.fn(async () => {});
		const sharedEnv = createNoopSessionEnv({ writeFile });
		const createSessionEnv = vi.fn(async () => sharedEnv);
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useSandbox({ createSessionEnv });
			useTool({
				name: 'write_report',
				description: 'Write a report.',
				harness: true,
				run: async ({ harness }) => {
					await harness.sandbox.writeFile('report.txt', 'complete');
					return { done: true };
				},
			});
			return 'Case agent.';
		}
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('write_report', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const harness = await createDirectContext(provider).initializeRootHarness(
			defineAgent(assistant),
		);

		await (await harness.session()).prompt('Write the report.');

		expect(createSessionEnv).toHaveBeenCalledOnce();
		expect(writeFile).toHaveBeenCalledWith('report.txt', 'complete');
	});
});
