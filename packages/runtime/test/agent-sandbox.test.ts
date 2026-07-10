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
import { defineAgent } from '../src/agent-definition.ts';
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
					definition: defineAgent(assistant),
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
					definition: defineAgent(assistant),
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
					definition: defineAgent(assistant),
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

	it('reads a conditional sandbox once per submission: mid-submission flips stay sticky, the next submission attaches', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();
		// Submission 1: enable the sandbox (flips persistent state), then probe —
		// the flip must NOT crash the run at the turn boundary, and the probe
		// still runs in the default env (the declaration was read at init).
		// Submission 2: probe again — init re-reads the declaration, which now
		// attaches, so the probe runs in the sandbox env.
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
					definition: defineAgent(assistant),
				},
			],
			createContext,
			conversationStreamStore,
			attachmentStore,
		});

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:sandbox-flip-1' }));
		await coordinator.waitForIdle();
		// The flip happened mid-submission: the env stayed the default one for
		// the whole run, and the sandbox factory was never consulted.
		expect(defaultExecs).toEqual(['pwd']);
		expect(sandboxExecs).toEqual([]);
		expect(sandboxEnvBuilds).toBe(0);

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:sandbox-flip-2' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The next submission's init re-read the declaration: persistent state
		// replays as true, so the sandbox attached and the probe ran inside it.
		expect(sandboxEnvBuilds).toBeGreaterThanOrEqual(1);
		expect(sandboxExecs).toEqual(['pwd']);
		expect(defaultExecs).toEqual(['pwd']);
	});
});
