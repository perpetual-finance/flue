import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import * as v from 'valibot';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assertRenderStructureInvariance,
	renderAgentFunctionWithStructure,
} from '../src/hooks/render.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { usePersistentState } from '../src/hooks/use-persistent-state.ts';
import { useSandbox } from '../src/hooks/use-sandbox.ts';
import { useSkill } from '../src/hooks/use-skill.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { defineSkill } from '../src/skill-definition.ts';
import { defineTool, validateAndRunTool } from '../src/tool.ts';
import type { SandboxFactory, SessionEnv } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true });
		} catch {}
	}
});

function createFauxProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `agent-sandbox-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-sandbox-'));
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

const CONFIG = { model: 'faux/agent-sandbox' };

function stubFactory(env: SessionEnv = createNoopSessionEnv()): SandboxFactory {
	return { createSessionEnv: async () => env };
}

describe('useSandbox() (render)', () => {
	it('attaches the sandbox to the rendered config', () => {
		const factory = stubFactory();
		const withIt = renderAgentFunctionWithStructure(() => {
			useModel(CONFIG.model);
			useSandbox(factory);
			return 'Base.';
		});
		expect(withIt.config.sandbox).toBe(factory);

		const withoutIt = renderAgentFunctionWithStructure(() => {
			useModel(CONFIG.model);
			return 'Base.';
		});
		expect(withoutIt.config.sandbox).toBeUndefined();
	});

	it('is callable from a nested custom hook', () => {
		const factory = stubFactory();
		function useCompanySandbox() {
			useSandbox(factory);
		}
		function useEnvironment() {
			useCompanySandbox();
		}
		const rendered = renderAgentFunctionWithStructure(() => {
			useModel(CONFIG.model);
			useEnvironment();
			return 'Base.';
		});
		expect(rendered.config.sandbox).toBe(factory);
	});

	it('throws when called twice in one render, wherever the calls live', () => {
		const useEnvironment = () => {
			useSandbox(stubFactory());
		};
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				useSandbox(stubFactory());
				useEnvironment();
				return 'Base.';
			}),
		).toThrow(/useSandbox\(\) was called twice in one render/);
	});

	it('rejects values that are not sandbox factories', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(CONFIG.model);
				useSandbox({} as SandboxFactory);
				return 'Base.';
			}),
		).toThrow(/requires a sandbox factory/);
	});

	it('throws outside an agent render', () => {
		expect(() => useSandbox(stubFactory())).toThrow(/called outside an agent function/);
	});
});

describe('useSandbox() invariance', () => {
	it('tolerates conditional attachment — the declaration is submission-scoped, not identity', () => {
		let attach = false;
		const agent = () => {
			useModel(CONFIG.model);
			if (attach) useSandbox(stubFactory());
			return 'Base.';
		};
		const render = () => renderAgentFunctionWithStructure(agent).structure;
		const without = render();
		attach = true;
		const withIt = render();
		expect(() => assertRenderStructureInvariance(without, withIt)).not.toThrow();
		expect(() => assertRenderStructureInvariance(withIt, without)).not.toThrow();
	});
});

describe('harness tools outside a session', () => {
	it('rejects standalone runs of harness: true tools', async () => {
		const tool = defineTool({
			name: 'probe',
			description: 'Probe the environment.',
			input: v.object({}),
			harness: true,
			run: ({ harness }) => harness.sandbox.exec('pwd').then((result) => result.stdout),
		});
		await expect(validateAndRunTool(tool, {})).rejects.toThrow(
			/Tool "probe" declares `harness: true` and can only run inside an agent session/,
		);
	});
});

describe('useSandbox end to end (node coordinator, faux provider)', () => {
	it('threads the sandbox env to the tool harness instead of the default env', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('inspect', {}, { id: 'tool:inspect-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
		]);

		const execCommands: string[] = [];
		let envBuilds = 0;
		let defaultEnvBuilds = 0;
		const env = createNoopSessionEnv({
			exec: async (command) => {
				execCommands.push(command);
				return { stdout: 'clean', stderr: '', exitCode: 0 };
			},
			readFile: async () => 'notes content',
		});
		const sandbox: SandboxFactory = {
			createSessionEnv: async () => {
				envBuilds += 1;
				return env;
			},
		};
		const createContext: CreateAgentContextFn = ({ id, request, initialEventIndex, dispatchId }) =>
			createFlueContext({
				id,
				dispatchId,
				env: {},
				req: request,
				initialEventIndex,
				agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
				createDefaultEnv: async () => {
					defaultEnvBuilds += 1;
					return createNoopSessionEnv({ cwd: '/' });
				},
			});

		let observed: string | undefined;
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useSandbox(sandbox);
			useTool({
				name: 'inspect',
				description: 'Inspect the working tree.',
				input: v.object({}),
				harness: true,
				run: async ({ harness }) => {
					const status = await harness.sandbox.exec('git status --porcelain');
					const notes = await harness.sandbox.readFile('/notes.md');
					observed = `${status.stdout}|${notes}`;
					return observed;
				},
			});
			return 'Inspector.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					agent: assistant,
				},
			],
			createContext,
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:sandbox-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(execCommands).toEqual(['git status --porcelain']);
		expect(observed).toBe('clean|notes content');
		// The render-attached sandbox backs every harness init (the SandboxFactory
		// contract allows repeated createSessionEnv calls with the same id); the
		// default env is never consulted.
		expect(envBuilds).toBeGreaterThanOrEqual(1);
		expect(defaultEnvBuilds).toBe(0);
	});

	it("replaces the framework's model-facing tool set when the sandbox provides tools()", async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();

		let toolNames: string[] | undefined;
		provider.setResponses([
			(context) => {
				toolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage('Done.');
			},
		]);

		const sandbox: SandboxFactory = {
			createSessionEnv: async () => createNoopSessionEnv(),
			tools: () => [
				{
					name: 'code',
					label: 'Run Code',
					description: 'Run a snippet.',
					parameters: { type: 'object', properties: {}, additionalProperties: false } as never,
					execute: async () => ({ content: [{ type: 'text' as const, text: 'ran' }], details: {} }),
				},
			],
		};

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useSandbox(sandbox);
			return 'Codemode agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					agent: assistant,
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:sandbox-2' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(toolNames).toBeDefined();
		expect(toolNames).toContain('code');
		expect(toolNames).toContain('task');
		expect(toolNames).not.toContain('bash');
		expect(toolNames).not.toContain('read');
	});

	it('hands the sandbox toolFactory an env that resolves packaged-skill paths', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.')]);

		const review = defineSkill({
			name: 'review',
			description: 'Reviews changes.',
			instructions: 'Review carefully.',
			files: { 'references/checklist.md': 'Check errors.' },
		});
		const checklistPath = `/.flue/packaged-skills/${encodeURIComponent(review.id)}/references/checklist.md`;

		let factoryEnv: SessionEnv | undefined;
		const sandbox: SandboxFactory = {
			createSessionEnv: async () => createNoopSessionEnv(),
			tools: (env) => {
				factoryEnv = env;
				return [];
			},
		};

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useSandbox(sandbox);
			useSkill(review);
			return 'Reviewer agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					agent: assistant,
				},
			],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:sandbox-3' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(factoryEnv).toBeDefined();
		// Adapter tools that read through the env resolve packaged paths — the
		// env-level overlay replaced the old wrap-the-tool-named-'read' remap.
		await expect(factoryEnv?.readFile(checklistPath)).resolves.toBe('Check errors.');
		await expect(factoryEnv?.readFile(`${checklistPath}.missing`)).rejects.toThrow(
			'Packaged skill file not found',
		);
	});

	it('attaches a conditional sandbox at the turn boundary and re-attaches at the next submission', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		// Submission 1: enable the sandbox (flips persistent state), then probe —
		// the swap lands at the turn boundary after the tool batch, so the probe
		// in the SAME submission already runs in the sandbox env.
		// Submission 2: probe again — init re-reads the declaration (persistent
		// state replays as true), so the sandbox re-attaches from turn one.
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('enable_sandbox', {}, { id: 'tool:enable-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage(fauxToolCall('probe', {}, { id: 'tool:probe-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Enabled.'),
			fauxAssistantMessage(fauxToolCall('probe', {}, { id: 'tool:probe-2' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Probed.'),
		]);

		const defaultExecs: string[] = [];
		const sandboxExecs: string[] = [];
		let sandboxEnvBuilds = 0;
		const sandbox: SandboxFactory = {
			createSessionEnv: async () => {
				sandboxEnvBuilds += 1;
				return createNoopSessionEnv({
					exec: async (command) => {
						sandboxExecs.push(command);
						return { stdout: 'sandbox', stderr: '', exitCode: 0 };
					},
				});
			},
		};
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
						exec: async (command) => {
							defaultExecs.push(command);
							return { stdout: 'default', stderr: '', exitCode: 0 };
						},
					}),
			});

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			const [enabled, setEnabled] = usePersistentState('sandboxEnabled', false);
			if (enabled) useSandbox(sandbox);
			useTool({
				name: 'enable_sandbox',
				description: 'Attach the workspace.',
				input: v.object({}),
				run: () => {
					setEnabled(true);
					return 'Sandbox enabled.';
				},
			});
			useTool({
				name: 'probe',
				description: 'Probe the environment.',
				input: v.object({}),
				harness: true,
				run: async ({ harness }) => (await harness.sandbox.exec('pwd')).stdout,
			});
			return 'Support agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					agent: assistant,
				},
			],
			createContext,
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:sandbox-flip-1' }));
		await coordinator.waitForIdle();
		// The flip landed at the turn boundary after enable_sandbox's batch:
		// the probe in the same submission already ran in the sandbox env,
		// and the default env never executed anything.
		expect(sandboxExecs).toEqual(['pwd']);
		expect(defaultExecs).toEqual([]);
		expect(sandboxEnvBuilds).toBeGreaterThanOrEqual(1);

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:sandbox-flip-2' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The next submission's init re-read the declaration: persistent state
		// replays as true, so the sandbox re-attached from turn one.
		expect(sandboxExecs).toEqual(['pwd', 'pwd']);
		expect(defaultExecs).toEqual([]);
	});
});

describe('conditional sandbox: turn-boundary swap (node coordinator, faux provider)', () => {
	function connectStores() {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		return (async () => {
			await adapter.migrate?.();
			return adapter.connect();
		})();
	}

	it('narrates ONE full environment snapshot at the swap, superseding delta narration', async () => {
		const { executionStore, conversationStreamStore, attachmentStore } = await connectStores();
		const provider = createFauxProvider();

		let postSwapMessages = '';
		let finalTurnMessages = '';
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('enable_sandbox', {}, { id: 'tool:enable-1' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				postSwapMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall('probe', {}, { id: 'tool:probe-1' }), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				finalTurnMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage('Done.');
			},
		]);

		const sandbox: SandboxFactory = {
			createSessionEnv: async () => createNoopSessionEnv({ cwd: '/sandbox' }),
		};
		const createContext: CreateAgentContextFn = ({ id, request, initialEventIndex, dispatchId }) =>
			createFlueContext({
				id,
				dispatchId,
				env: {},
				req: request,
				initialEventIndex,
				agentConfig: { subagents: {}, resolveModel: () => provider.getModel() },
				createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			});

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			const [enabled, setEnabled] = usePersistentState('sandboxEnabled', false);
			if (enabled) useSandbox(sandbox);
			// A resource that flips WITH the environment: the snapshot signal
			// must restate it, and the reconciler must not narrate it again as
			// a delta one turn later.
			if (enabled) {
				useTool({ name: 'diagnose', description: 'Diagnose the workspace.', run: () => 'ok' });
			}
			useTool({
				name: 'enable_sandbox',
				description: 'Attach the workspace.',
				run: () => {
					setEnabled(true);
					return 'Sandbox enabled.';
				},
			});
			useTool({
				name: 'probe',
				description: 'Probe the environment.',
				input: v.object({}),
				harness: true,
				run: async ({ harness }) => harness.sandbox.cwd,
			});
			return 'Support agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [{ name: 'assistant', agent: assistant }],
			createContext,
			conversationStreamStore,
			attachmentStore,
		});
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:env-signal-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The model's first post-swap turn read the full snapshot: forceful
		// preamble, the NEW cwd, and complete rosters including the tool that
		// appeared with the environment.
		expect(postSwapMessages).toContain('execution environment (sandbox) was replaced');
		expect(postSwapMessages).toContain('working directory is now `/sandbox`');
		expect(postSwapMessages).toContain('All available tools:');
		expect(postSwapMessages).toContain('diagnose');
		// Exactly one snapshot, and no delta narration trailing it: the swap
		// turn synced the narrated snapshot, so the reconciler stays quiet.
		expect(finalTurnMessages.split('execution environment (sandbox) was replaced')).toHaveLength(
			2,
		);
		expect(finalTurnMessages).not.toContain('New tool available');
	});

	it("swaps the sandbox's tools() into the model tool set at the boundary", async () => {
		const { executionStore, conversationStreamStore, attachmentStore } = await connectStores();
		const provider = createFauxProvider();

		let preSwapTools: string[] = [];
		let postSwapTools: string[] = [];
		provider.setResponses([
			(context) => {
				preSwapTools = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage(fauxToolCall('enable_sandbox', {}, { id: 'tool:enable-2' }), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				postSwapTools = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage('Done.');
			},
		]);

		const sandbox: SandboxFactory = {
			createSessionEnv: async () => createNoopSessionEnv({ cwd: '/sandbox' }),
			tools: () => [
				{
					name: 'code',
					label: 'Run Code',
					description: 'Run a snippet.',
					parameters: { type: 'object', properties: {}, additionalProperties: false } as never,
					execute: async () => ({ content: [{ type: 'text' as const, text: 'ran' }], details: {} }),
				},
			],
		};

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			const [enabled, setEnabled] = usePersistentState('sandboxEnabled', false);
			if (enabled) useSandbox(sandbox);
			useTool({
				name: 'enable_sandbox',
				description: 'Attach the workspace.',
				run: () => {
					setEnabled(true);
					return 'Sandbox enabled.';
				},
			});
			return 'Codemode agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [{ name: 'assistant', agent: assistant }],
			createContext: makeFauxCreateContext(provider),
			conversationStreamStore,
			attachmentStore,
		});
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:env-tools-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// Before the swap: the default env's builtins. After: the sandbox's
		// tools() REPLACES them, while declared and framework tools survive.
		expect(preSwapTools).toContain('bash');
		expect(preSwapTools).toContain('enable_sandbox');
		expect(postSwapTools).toContain('code');
		expect(postSwapTools).not.toContain('bash');
		expect(postSwapTools).toContain('enable_sandbox');
		expect(postSwapTools).toContain('task');
	});

	it('detaches to a fresh default environment when the condition clears', async () => {
		const { executionStore, conversationStreamStore, attachmentStore } = await connectStores();
		const provider = createFauxProvider();

		let postSwapMessages = '';
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('disable_sandbox', {}, { id: 'tool:disable-1' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				postSwapMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall('probe', {}, { id: 'tool:probe-2' }), {
					stopReason: 'toolUse',
				});
			},
			fauxAssistantMessage('Done.'),
		]);

		const sandboxExecs: string[] = [];
		const defaultExecs: string[] = [];
		const sandbox: SandboxFactory = {
			createSessionEnv: async () =>
				createNoopSessionEnv({
					cwd: '/sandbox',
					exec: async (command) => {
						sandboxExecs.push(command);
						return { stdout: 'sandbox', stderr: '', exitCode: 0 };
					},
				}),
		};
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
							defaultExecs.push(command);
							return { stdout: 'default', stderr: '', exitCode: 0 };
						},
					}),
			});

		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			const [enabled, setEnabled] = usePersistentState('sandboxEnabled', true);
			if (enabled) useSandbox(sandbox);
			useTool({
				name: 'disable_sandbox',
				description: 'Detach the workspace.',
				run: () => {
					setEnabled(false);
					return 'Sandbox disabled.';
				},
			});
			useTool({
				name: 'probe',
				description: 'Probe the environment.',
				input: v.object({}),
				harness: true,
				run: async ({ harness }) => (await harness.sandbox.exec('pwd')).stdout,
			});
			return 'Support agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [{ name: 'assistant', agent: assistant }],
			createContext,
			conversationStreamStore,
			attachmentStore,
		});
		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:env-detach-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// Attached at init (default state true), detached at the boundary: the
		// probe ran in the default env, and the swap was narrated with the
		// default env's cwd.
		expect(sandboxExecs).toEqual([]);
		expect(defaultExecs).toEqual(['pwd']);
		expect(postSwapMessages).toContain('execution environment (sandbox) was replaced');
		expect(postSwapMessages).toContain('working directory is now `/`');
	});

	it('keeps the prompt frozen across the swap, then re-discovers at compaction', async () => {
		const provider = createFauxProvider();
		const model = provider.getModel();

		let preCompactPrompt: string | undefined;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('enable_sandbox', {}, { id: 'tool:enable-3' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				// The turn AFTER the swap: env already replaced, prompt not.
				preCompactPrompt = context.systemPrompt;
				return fauxAssistantMessage('enabled');
			},
			fauxAssistantMessage('another turn'),
			// Compaction may split the tool turn: prefix + main summarization.
			fauxAssistantMessage('summary prefix'),
			fauxAssistantMessage('summary checkpoint'),
		]);

		const sandbox: SandboxFactory = {
			createSessionEnv: async () => createNoopSessionEnv({ cwd: '/sandbox' }),
		};
		function assistant() {
			useModel(`${model.provider}/${model.id}`, {
				// Without a tiny keep-window the default swallows this short
				// history and manual compaction finds nothing to cut.
				compaction: { keepRecentTokens: 3 },
			});
			const [enabled, setEnabled] = usePersistentState('sandboxEnabled', false);
			if (enabled) useSandbox(sandbox);
			useTool({
				name: 'enable_sandbox',
				description: 'Attach the workspace.',
				run: () => {
					setEnabled(true);
					return 'Sandbox enabled.';
				},
			});
			return 'Support agent.';
		}

		const ctx = createFlueContext({
			id: 'instance-env-rediscover',
			env: {},
			agentConfig: { resolveModel: () => model },
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
		});
		const events: unknown[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(assistant);
		const session = await harness.session();

		expect(harness.sandbox.cwd).toBe('/');
		await session.prompt('Enable the workspace.');
		// The public surface is a LIVE getter: it follows the swap.
		expect(harness.sandbox.cwd).toBe('/sandbox');
		await session.prompt('Filler turn.');

		await session.compact();

		let postCompactPrompt: string | undefined;
		provider.setResponses([
			(context) => {
				postCompactPrompt = context.systemPrompt;
				return fauxAssistantMessage('Post-compaction turn.');
			},
		]);
		await session.prompt('Where are you now?');

		// Compaction actually ran (a no-op compact would leave the frozen
		// prompt in place and prove nothing).
		expect(events.some((event) => (event as { type: string }).type === 'compaction')).toBe(true);
		// Frozen until compaction: the post-swap turns kept describing the
		// init-time workspace — the transcript's earlier commands really ran
		// there, and rewriting history mid-submission would contradict them.
		expect(preCompactPrompt).toContain('Working directory: /');
		expect(preCompactPrompt).not.toContain('/sandbox');
		// The rebaseline re-discovered against the CURRENT env: the reborn
		// prompt describes where the agent actually is.
		expect(postCompactPrompt).toContain('Working directory: /sandbox');
	});
});
