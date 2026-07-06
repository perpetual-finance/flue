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
import { use } from '../src/hooks/use.ts';
import { useSandbox } from '../src/hooks/use-sandbox.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
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
	it('attaches the sandbox to the rendered config and marks the structure', () => {
		const factory = stubFactory();
		const withIt = renderAgentFunctionWithStructure(() => {
			useSandbox(factory);
			return 'Base.';
		}, CONFIG);
		expect(withIt.config.sandbox).toBe(factory);
		expect(withIt.structure.hasSandbox).toBe(true);

		const withoutIt = renderAgentFunctionWithStructure(() => 'Base.', CONFIG);
		expect(withoutIt.config.sandbox).toBeUndefined();
		expect(withoutIt.structure.hasSandbox).toBe(false);
	});

	it('is callable from a capability or a custom wrapper hook', () => {
		const factory = stubFactory();
		function useCompanySandbox() {
			useSandbox(factory);
		}
		function Environment() {
			useCompanySandbox();
			return 'Runs in the company environment.';
		}
		const rendered = renderAgentFunctionWithStructure(() => {
			use(Environment);
			return 'Base.';
		}, CONFIG);
		expect(rendered.config.sandbox).toBe(factory);
	});

	it('throws when called twice in one render, wherever the calls live', () => {
		const Environment = () => {
			useSandbox(stubFactory());
			return undefined;
		};
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSandbox(stubFactory());
				use(Environment);
				return 'Base.';
			}, CONFIG),
		).toThrow(/useSandbox\(\) was called twice in one render/);
	});

	it('rejects values that are not sandbox factories', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSandbox({} as SandboxFactory);
				return 'Base.';
			}, CONFIG),
		).toThrow(/requires a sandbox factory/);
	});

	it('throws outside an agent render', () => {
		expect(() => useSandbox(stubFactory())).toThrow(/called outside an agent function/);
	});
});

describe('useSandbox() invariance', () => {
	it('names the delta when the sandbox is attached conditionally', () => {
		let attach = false;
		const agent = () => {
			if (attach) useSandbox(stubFactory());
			return 'Base.';
		};
		const render = () => renderAgentFunctionWithStructure(agent, CONFIG).structure;
		const without = render();
		attach = true;
		const withIt = render();
		expect(() => assertRenderStructureInvariance(without, withIt)).toThrow(/sandbox added/);
		expect(() => assertRenderStructureInvariance(withIt, without)).toThrow(/sandbox removed/);
	});
});

describe('harness tools outside a session', () => {
	it('rejects standalone runs of harness: true tools', async () => {
		const tool = defineTool({
			name: 'probe',
			description: 'Probe the environment.',
			input: v.object({}),
			harness: true,
			run: ({ harness }) => harness.shell('pwd').then((result) => result.stdout),
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
			useSandbox(sandbox);
			useTool({
				name: 'inspect',
				description: 'Inspect the working tree.',
				input: v.object({}),
				harness: true,
				run: async ({ harness }) => {
					const status = await harness.shell('git status --porcelain');
					const notes = await harness.fs.readFile('/notes.md');
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
					definition: defineAgent(assistant, {
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
					}),
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
			useSandbox(sandbox);
			return 'Codemode agent.';
		}

		const coordinator = createNodeAgentCoordinator({
			submissions: executionStore.submissions,
			agents: [
				{
					name: 'assistant',
					definition: defineAgent(assistant, {
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
					}),
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
});
