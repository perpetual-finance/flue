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
import { defineAgent } from '../src/agent-definition.ts';
import {
	assertRenderStructureInvariance,
	renderAgentFunctionWithStructure,
} from '../src/hooks/render.ts';
import { use } from '../src/hooks/use.ts';
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

const CONFIG = { model: 'faux/agent-skill' };

describe('useSkill() (render)', () => {
	it('attaches packaged and bare catalog skills to the rendered config, in call order', () => {
		const packaged = defineSkill({
			name: 'triage-reproduce',
			description: 'Deep instructions for reproducing a reported issue.',
			instructions: 'Reproduce carefully.',
		});
		const bare: Skill = { name: 'release-notes', description: 'Workspace release-notes rules.' };
		const rendered = renderAgentFunctionWithStructure(() => {
			useSkill(packaged);
			useSkill(bare);
			return 'Base.';
		}, CONFIG);
		expect(rendered.config.skills).toEqual([packaged, bare]);
		expect(rendered.structure.skillNames).toEqual(['triage-reproduce', 'release-notes']);
	});

	it('collects skills mounted by capabilities into the flat catalog', () => {
		const skill = defineSkill({
			name: 'triage-verify',
			description: 'Verify a fix against the reproduction.',
			instructions: 'Verify carefully.',
		});
		function VerifyPhase() {
			useSkill(skill);
			return 'Verify phase.';
		}
		const rendered = renderAgentFunctionWithStructure(() => {
			use(VerifyPhase);
			return 'Base.';
		}, CONFIG);
		expect(rendered.config.skills).toEqual([skill]);
	});

	it('throws when one render mounts the same skill name twice', () => {
		const entry: Skill = { name: 'twice', description: 'Mounted twice.' };
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSkill(entry);
				useSkill({ name: 'twice', description: 'Different object, same name.' });
				return 'Base.';
			}, CONFIG),
		).toThrow(/mounted the skill name "twice" twice/);
	});

	it('rejects values that are not skills', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSkill('triage' as unknown as Skill);
				return 'Base.';
			}, CONFIG),
		).toThrow(/requires a skill/);
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSkill({ name: 'no-description', description: '' });
				return 'Base.';
			}, CONFIG),
		).toThrow(/needs a non-empty description/);
	});

	it('throws outside an agent render', () => {
		expect(() => useSkill({ name: 'outside', description: 'Nope.' })).toThrow(
			/called outside an agent function/,
		);
	});
});

describe('useSkill() invariance', () => {
	it('names the delta when a skill is mounted conditionally', () => {
		let mount = false;
		const agent = () => {
			if (mount) useSkill({ name: 'flaky', description: 'Sometimes mounted.' });
			return 'Base.';
		};
		const render = () => renderAgentFunctionWithStructure(agent, CONFIG).structure;
		const without = render();
		mount = true;
		const withIt = render();
		expect(() => assertRenderStructureInvariance(without, withIt)).toThrow(/skills added flaky/);
		expect(() => assertRenderStructureInvariance(withIt, without)).toThrow(/skills removed flaky/);
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
		function ReproducePhase() {
			useSkill(skill);
			return 'Activate the `triage-reproduce` skill before starting this phase.';
		}
		function assistant() {
			use(ReproducePhase);
			return 'Issue triage agent.';
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
