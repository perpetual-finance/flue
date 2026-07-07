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
	resolveSubagentDefinition,
} from '../src/hooks/render.ts';
import { useState } from '../src/hooks/state.ts';
import { useInstruction } from '../src/hooks/use-instruction.ts';
import { useSandbox } from '../src/hooks/use-sandbox.ts';
import { useSkill } from '../src/hooks/use-skill.ts';
import { useSubagent } from '../src/hooks/use-subagent.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import type { SubagentDefinition } from '../src/types.ts';
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
		provider: `agent-subagent-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-subagent-'));
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

const CONFIG = { model: 'faux/agent-subagent' };

function Helper() {
	return 'You are the helper.';
}

describe('useSubagent() (render)', () => {
	it('declares delegates on the rendered config, in call order', () => {
		const rendered = renderAgentFunctionWithStructure(() => {
			useSubagent({ name: 'helper', description: 'Handles focused work.', agent: Helper });
			useSubagent({
				name: 'checker',
				description: 'Verifies results.',
				agent: Helper,
				model: 'anthropic/claude-haiku-4-5',
			});
			return 'Base.';
		}, CONFIG);
		expect(rendered.structure.subagentNames).toEqual(['helper', 'checker']);
		expect(rendered.config.subagents).toHaveLength(2);
		expect(rendered.config.subagents?.[1]).toMatchObject({
			name: 'checker',
			model: 'anthropic/claude-haiku-4-5',
		});
	});

	it('collects declarations made inside a custom hook', () => {
		function usePhase() {
			useSubagent({ name: 'helper', description: 'Handles focused work.', agent: Helper });
			useInstruction('Phase.');
		}
		const rendered = renderAgentFunctionWithStructure(() => {
			usePhase();
			return 'Base.';
		}, CONFIG);
		expect(rendered.structure.subagentNames).toEqual(['helper']);
	});

	it('throws on duplicate delegate names, missing agent function, and bad shapes', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSubagent({ name: 'twin', description: 'One.', agent: Helper });
				useSubagent({ name: 'twin', description: 'Two.', agent: Helper });
				return 'Base.';
			}, CONFIG),
		).toThrow(/declared the subagent name "twin" twice/);
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSubagent({ name: 'broken', description: 'No fn.' } as SubagentDefinition);
				return 'Base.';
			}, CONFIG),
		).toThrow(/needs `agent`/);
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				useSubagent({ name: 'mute', description: '', agent: Helper });
				return 'Base.';
			}, CONFIG),
		).toThrow(/needs a non-empty description/);
	});

	it('throws outside an agent render', () => {
		expect(() => useSubagent({ name: 'outside', description: 'Nope.', agent: Helper })).toThrow(
			/called outside an agent function/,
		);
	});

	it('names the invariance delta when a delegate is declared conditionally', () => {
		let declare = false;
		const agent = () => {
			if (declare) {
				useSubagent({ name: 'flaky', description: 'Sometimes.', agent: Helper });
			}
			return 'Base.';
		};
		const render = () => renderAgentFunctionWithStructure(agent, CONFIG).structure;
		const without = render();
		declare = true;
		expect(() => assertRenderStructureInvariance(without, render())).toThrow(
			/subagents added flaky/,
		);
	});
});

describe('resolveSubagentDefinition() (delegation-time render)', () => {
	it('renders the capability into a self-contained profile: instruction doc, tools, skills, nested delegates', () => {
		function Verifier() {
			useTool({ name: 'run_check', description: 'Run one check.', run: () => 'ok' });
			return 'You verify results.';
		}
		function Reproducer() {
			useInstruction('Work only inside the triage directory.');
			useSkill({ name: 'reproduce', description: 'Reproduction playbook.' });
			useTool({ name: 'write_report', description: 'Write report.md.', run: () => 'ok' });
			useSubagent({ name: 'verifier', description: 'Verifies.', agent: Verifier });
			return 'You reproduce one issue.';
		}
		const profile = resolveSubagentDefinition({
			name: 'reproducer',
			description: 'Reproduces one issue.',
			agent: Reproducer,
		});
		expect(profile.name).toBe('reproducer');
		expect(profile.description).toBe('Reproduces one issue.');
		expect(profile.instructions).toBe(
			'You reproduce one issue.\n\nWork only inside the triage directory.',
		);
		expect(profile.tools?.map((tool) => tool.name)).toEqual(['write_report']);
		expect(profile.skills?.map((skill) => skill.name)).toEqual(['reproduce']);
		expect(profile.subagents?.map((sub) => sub.name)).toEqual(['verifier']);
		expect(profile.model).toBeUndefined();
	});

	it('renders fresh per delegation — closures read current values', () => {
		let tone = 'strict';
		function Reviewer() {
			return `Review in a ${tone} tone.`;
		}
		const definition: SubagentDefinition = {
			name: 'reviewer',
			description: 'Reviews.',
			agent: Reviewer,
		};
		expect(resolveSubagentDefinition(definition).instructions).toBe('Review in a strict tone.');
		tone = 'kind';
		expect(resolveSubagentDefinition(definition).instructions).toBe('Review in a kind tone.');
	});

	it('rejects root-scoped hooks in the delegate render', () => {
		function WithState() {
			useState('count', 0);
			return 'Nope.';
		}
		expect(() =>
			resolveSubagentDefinition({ name: 's', description: 'd', agent: WithState }),
		).toThrow(/useState\(\) is not available in a subagent render/);
		function WithSandbox() {
			useSandbox({ createSessionEnv: async () => createNoopSessionEnv() });
			return 'Nope.';
		}
		expect(() =>
			resolveSubagentDefinition({ name: 's', description: 'd', agent: WithSandbox }),
		).toThrow(/useSandbox\(\) is not available in a subagent render/);
	});
});

describe('useSubagent end to end (node coordinator, faux provider)', () => {
	it('catalogs the delegate on the task tool and runs a delegated round trip', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();

		let taskToolDescription: string | undefined;
		let childSystemPrompt: string | undefined;
		let childToolNames: string[] | undefined;
		let parentSawResult = false;
		provider.setResponses([
			// Parent turn 1: read the catalog, delegate to the helper.
			(context) => {
				taskToolDescription = context.tools?.find((tool) => tool.name === 'task')?.description;
				return fauxAssistantMessage(
					fauxToolCall(
						'task',
						{ prompt: 'Summarize the case.', agent: 'summarizer' },
						{ id: 'tool:task-1' },
					),
					{ stopReason: 'toolUse' },
				);
			},
			// Child turn: capture the delegate's world, answer.
			(context) => {
				childSystemPrompt = context.systemPrompt;
				childToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage('CHILD-SUMMARY-COMPLETE');
			},
			// Parent turn 2: the task result is in history.
			(context) => {
				parentSawResult = JSON.stringify(context.messages).includes('CHILD-SUMMARY-COMPLETE');
				return fauxAssistantMessage('Done.');
			},
		]);

		function Summarizer() {
			useTool({
				name: 'grade_summary',
				description: 'Grade a draft summary.',
				input: v.object({}),
				run: () => 'graded',
			});
			return 'You summarize support cases in three sentences.';
		}
		function assistant() {
			useSubagent({
				name: 'summarizer',
				description: 'Summarizes one support case.',
				agent: Summarizer,
			});
			return 'Case agent.';
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

		await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:subagent-1' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// Catalog line rides the task tool description.
		expect(taskToolDescription).toContain('- summarizer: Summarizes one support case.');
		// The delegate's world is exactly what its capability composed.
		expect(childSystemPrompt).toContain('You summarize support cases in three sentences.');
		expect(childSystemPrompt).not.toContain('Case agent.');
		expect(childToolNames).toContain('grade_summary');
		// Only the final text returned to the parent.
		expect(parentSawResult).toBe(true);
	});
});
