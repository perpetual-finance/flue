import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import { afterEach, describe, expect, it } from 'vitest';
import {
	assertRenderStructureInvariance,
	renderAgentFunctionWithStructure,
} from '../src/hooks/render.ts';
import { useInstruction } from '../src/hooks/use-instruction.ts';
import { useModel } from '../src/hooks/use-model.ts';
import { useSkill } from '../src/hooks/use-skill.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { defineSkill } from '../src/skill-definition.ts';
import type { Skill } from '../src/types.ts';
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
		provider: `agent-skill-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-skill-'));
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

const MODEL = 'faux/agent-skill';

describe('useSkill() (render)', () => {
	it('attaches packaged and bare catalog skills to the rendered config, in call order', () => {
		const packaged = defineSkill({
			name: 'triage-reproduce',
			description: 'Deep instructions for reproducing a reported issue.',
			instructions: 'Reproduce carefully.',
		});
		const bare: Skill = { name: 'release-notes', description: 'Workspace release-notes rules.' };
		const rendered = renderAgentFunctionWithStructure(() => {
			useModel(MODEL);
			useSkill(packaged);
			useSkill(bare);
			return 'Base.';
		});
		expect(rendered.config.skills).toEqual([packaged, bare]);
		expect(rendered.structure.resources.skills.map((skill) => skill.name)).toEqual([
			'triage-reproduce',
			'release-notes',
		]);
	});

	it('collects skills mounted by a custom hook into the flat catalog', () => {
		const skill = defineSkill({
			name: 'triage-verify',
			description: 'Verify a fix against the reproduction.',
			instructions: 'Verify carefully.',
		});
		function useVerifyPhase() {
			useSkill(skill);
			useInstruction('Verify phase.');
		}
		const rendered = renderAgentFunctionWithStructure(() => {
			useModel(MODEL);
			useVerifyPhase();
			return 'Base.';
		});
		expect(rendered.config.skills).toEqual([skill]);
	});

	it('throws when one render mounts the same skill name twice', () => {
		const entry: Skill = { name: 'twice', description: 'Mounted twice.' };
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(MODEL);
				useSkill(entry);
				useSkill({ name: 'twice', description: 'Different object, same name.' });
				return 'Base.';
			}),
		).toThrow(/mounted the skill name "twice" twice/);
	});

	it('rejects values that are not skills', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(MODEL);
				useSkill('triage' as unknown as Skill);
				return 'Base.';
			}),
		).toThrow(/requires a skill/);
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useModel(MODEL);
				useSkill({ name: 'no-description', description: '' });
				return 'Base.';
			}),
		).toThrow(/needs a non-empty description/);
	});

	it('throws outside an agent render', () => {
		expect(() => useSkill({ name: 'outside', description: 'Nope.' })).toThrow(
			/called outside an agent function/,
		);
	});
});

describe('useSkill() dynamic declaration', () => {
	it('allows conditional mounting — the delta surfaces in the resources snapshot', () => {
		let mount = false;
		const agent = () => {
			useModel(MODEL);
			if (mount) useSkill({ name: 'flaky', description: 'Sometimes mounted.' });
			return 'Base.';
		};
		const render = () => renderAgentFunctionWithStructure(agent).structure;
		const without = render();
		mount = true;
		const withIt = render();
		expect(() => assertRenderStructureInvariance(without, withIt)).not.toThrow();
		expect(() => assertRenderStructureInvariance(withIt, without)).not.toThrow();
		expect(without.resources.skills).toEqual([]);
		expect(withIt.resources.skills).toEqual([
			{ name: 'flaky', description: 'Sometimes mounted.' },
		]);
	});
});

describe('useSkill end to end (node coordinator, faux provider)', () => {
	it('catalogs the skill in the system prompt and serves the briefing via activate_skill', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();

		let systemPrompt: string | undefined;
		let toolNames: string[] | undefined;
		let briefingTurn: string | undefined;
		provider.setResponses([
			(context) => {
				systemPrompt = context.systemPrompt;
				toolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage(
					fauxToolCall('activate_skill', { name: 'triage-reproduce' }, { id: 'tool:skill-1' }),
					{ stopReason: 'toolUse' },
				);
			},
			(context) => {
				briefingTurn = JSON.stringify(context.messages);
				return fauxAssistantMessage('Done.');
			},
		]);

		const skill = defineSkill({
			name: 'triage-reproduce',
			description: 'Deep instructions for reproducing a reported issue.',
			instructions: 'Reproduce carefully, starting from a minimal project.',
		});
		function useReproducePhase() {
			useSkill(skill);
			useInstruction('Activate the `triage-reproduce` skill before starting this phase.');
		}
		function assistant() {
			useModel(`${provider.getModel().provider}/${provider.getModel().id}`);
			useReproducePhase();
			return 'Issue triage agent.';
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

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:skill-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The catalog is a stable part of the prompt: one line, name + description.
		expect(systemPrompt).toContain('## Available Skills');
		expect(systemPrompt).toContain(
			'- **triage-reproduce** — Deep instructions for reproducing a reported issue.',
		);
		// The skill's full instructions are NOT in the prompt — disclosure is lazy.
		expect(systemPrompt).not.toContain('Reproduce carefully');
		expect(toolNames).toContain('activate_skill');
		// The briefing arrived as the activate_skill tool result.
		expect(briefingTurn).toContain('Reproduce carefully, starting from a minimal project.');
		expect(briefingTurn).toContain('skill_instructions');
	});
});
