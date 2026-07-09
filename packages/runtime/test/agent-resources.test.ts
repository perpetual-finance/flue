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
import { usePersistentState } from '../src/hooks/use-persistent-state.ts';
import { useSkill } from '../src/hooks/use-skill.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import {
	diffResourceSnapshots,
	digestInstructions,
	INSTRUCTIONS_UPDATED_SIGNAL_BODY,
	instructionsChanged,
	type ResourceSnapshot,
	renderResourceSignalBody,
} from '../src/resources.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { defineSkill } from '../src/skill-definition.ts';
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
		provider: `agent-resources-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-resources-'));
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

const snapshot = (partial: Partial<ResourceSnapshot>): ResourceSnapshot => ({
	skills: [],
	tools: [],
	subagents: [],
	...partial,
});

describe('diffResourceSnapshots()', () => {
	it('returns nothing when the sets are unchanged', () => {
		const a = snapshot({
			skills: [{ name: 'faq', description: 'Answer FAQs.' }],
			tools: [{ name: 'lookup', description: 'Look up.', schema: '{"type":"object"}' }],
		});
		expect(diffResourceSnapshots(a, snapshot(a))).toEqual([]);
	});

	it('reports adds, removals, and updates per kind, by name', () => {
		const before = snapshot({
			skills: [{ name: 'faq', description: 'Answer FAQs.' }],
			tools: [
				{ name: 'lookup', description: 'Look up.', schema: 'v1' },
				{ name: 'page_oncall', description: 'Page.' },
			],
		});
		const after = snapshot({
			skills: [
				{ name: 'faq', description: 'Answer common questions.' },
				{ name: 'refunds', description: 'Process refunds.' },
			],
			tools: [{ name: 'lookup', description: 'Look up.', schema: 'v2' }],
			subagents: [{ name: 'investigator', description: 'Digs in.' }],
		});
		expect(diffResourceSnapshots(before, after)).toEqual([
			{
				kind: 'skill',
				added: [{ name: 'refunds', description: 'Process refunds.' }],
				removed: [],
				updated: [{ name: 'faq', description: 'Answer common questions.' }],
			},
			{
				kind: 'tool',
				added: [],
				removed: ['page_oncall'],
				// A schema-digest change alone counts as an update.
				updated: [{ name: 'lookup', description: 'Look up.', schema: 'v2' }],
			},
			{
				kind: 'subagent',
				added: [{ name: 'investigator', description: 'Digs in.' }],
				removed: [],
				updated: [],
			},
		]);
	});
});

describe('renderResourceSignalBody()', () => {
	it('renders a skill add as a catalog line plus the roster', () => {
		const body = renderResourceSignalBody(
			{
				kind: 'skill',
				added: [{ name: 'refund', description: 'Process refund requests.' }],
				removed: [],
				updated: [],
			},
			['faq', 'refund', 'escalation'],
		);
		expect(body).toBe(
			'New skill available:\n- **refund** — Process refund requests.\nAll available skills: faq, refund, escalation',
		);
	});

	it('renders removals and tool updates factually, name-only for tool updates', () => {
		// Tool updates never reprint description or schema: the live spec is
		// in the request's tools array (and the change cache-busts anyway).
		const body = renderResourceSignalBody(
			{
				kind: 'tool',
				added: [],
				removed: ['page_oncall'],
				updated: [{ name: 'record_report', description: 'Record.', schema: 'v2' }],
			},
			['bash', 'record_report'],
		);
		expect(body).toBe(
			'The tool "page_oncall" is no longer available.\nThe tool "record_report" was updated.\nAll available tools: bash, record_report',
		);
	});

	it('reprints the new description for skill updates and pluralizes multi-adds', () => {
		const body = renderResourceSignalBody(
			{
				kind: 'skill',
				added: [
					{ name: 'a', description: 'A.' },
					{ name: 'b', description: 'B.' },
				],
				removed: [],
				updated: [{ name: 'faq', description: 'Answer common questions.' }],
			},
			['a', 'b', 'faq'],
		);
		expect(body).toContain('New skills available:');
		expect(body).toContain('The skill "faq" was updated:\n- **faq** — Answer common questions.');
	});

	it('speaks of subagents as agents (the task-tool vocabulary)', () => {
		const body = renderResourceSignalBody(
			{
				kind: 'subagent',
				added: [{ name: 'investigator', description: 'Digs in.' }],
				removed: [],
				updated: [],
			},
			['investigator'],
		);
		expect(body).toContain('New agent available:');
		expect(body).toContain('All available agents: investigator');
	});
});

describe('digestInstructions() / instructionsChanged()', () => {
	it('is deterministic, distinguishes texts, and treats undefined as empty', () => {
		expect(digestInstructions('Support agent.')).toBe(digestInstructions('Support agent.'));
		expect(digestInstructions('Support agent.')).not.toBe(digestInstructions('Sales agent.'));
		expect(digestInstructions(undefined)).toBe(digestInstructions(''));
		expect(digestInstructions(undefined)).not.toBe(digestInstructions('Support agent.'));
	});

	it('detects a digest move, never a pre-digest baseline', () => {
		const before = snapshot({ instructionsDigest: digestInstructions('Phase: gathering.') });
		const after = snapshot({ instructionsDigest: digestInstructions('Phase: drafting.') });
		expect(instructionsChanged(before, after)).toBe(true);
		expect(instructionsChanged(before, snapshot(before))).toBe(false);
		// A snapshot recorded before the field existed adopts silently.
		expect(instructionsChanged(snapshot({}), after)).toBe(false);
	});
});

describe('dynamic resources end to end (node coordinator, faux provider)', () => {
	it('announces an instruction change between renders — signal only, no diff', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();

		let turnOneSystemPrompt: string | undefined;
		let turnTwoSystemPrompt: string | undefined;
		let turnTwoMessages: string | undefined;
		let turnThreeMessages: string | undefined;
		provider.setResponses([
			(context) => {
				turnOneSystemPrompt = context.systemPrompt;
				return fauxAssistantMessage(fauxToolCall('begin_draft', {}, { id: 'tool:draft-1' }), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				// The prompt swapped live; the change is announced in-conversation.
				turnTwoSystemPrompt = context.systemPrompt;
				turnTwoMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall('noop', {}, { id: 'tool:noop-1' }), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				// No instruction change between turn 2 and 3: no second signal.
				turnThreeMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage('Drafting.');
			},
		]);

		function assistant() {
			const [phase, setPhase] = usePersistentState('phase', 'gathering');
			useTool({
				name: 'begin_draft',
				description: 'Move to drafting.',
				run: () => {
					setPhase('drafting');
					return 'ok';
				},
			});
			useTool({ name: 'noop', description: 'Do nothing.', run: () => 'ok' });
			return `Support agent. Current phase: ${phase}.`;
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
		await coordinator.admitDispatch(makeDispatchInput({ id: 'instance-instruction-flip' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The prompt itself follows the render (live interpolation)…
		expect(turnOneSystemPrompt).toContain('Current phase: gathering.');
		expect(turnTwoSystemPrompt).toContain('Current phase: drafting.');
		// …and the change is announced: signal only, never the content.
		expect(turnTwoMessages).toContain(INSTRUCTIONS_UPDATED_SIGNAL_BODY);
		expect(turnTwoMessages).not.toContain('gathering'); // no diff, no old text
		// An unchanged render narrates nothing new.
		const occurrences = turnThreeMessages?.split(INSTRUCTIONS_UPDATED_SIGNAL_BODY).length;
		expect(occurrences).toBe(2); // exactly one occurrence → split yields two parts
	});

	it('flips a skill mid-run: narrated, activatable, catalog stays frozen', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();

		let baselineTools: string[] | undefined;
		let postFlipTools: string[] | undefined;
		let postFlipMessages: string | undefined;
		let missMessages: string | undefined;
		let briefingMessages: string | undefined;
		let finalSystemPrompt: string | undefined;
		provider.setResponses([
			(context) => {
				baselineTools = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage(fauxToolCall('upgrade', {}, { id: 'tool:up-1' }), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				postFlipTools = (context.tools ?? []).map((tool) => tool.name);
				postFlipMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(
					fauxToolCall('activate_skill', { name: 'nope' }, { id: 'tool:miss-1' }),
					{ stopReason: 'toolUse' },
				);
			},
			(context) => {
				missMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage(
					fauxToolCall('activate_skill', { name: 'refunds' }, { id: 'tool:hit-1' }),
					{ stopReason: 'toolUse' },
				);
			},
			(context) => {
				briefingMessages = JSON.stringify(context.messages);
				finalSystemPrompt = context.systemPrompt;
				return fauxAssistantMessage('Refund handled.');
			},
		]);

		const refundsSkill = defineSkill({
			name: 'refunds',
			description: 'Process refund requests against the orders API.',
			instructions: 'Verify the order, then issue the refund.',
		});
		function assistant() {
			const [pro, setPro] = usePersistentState('pro', false);
			if (pro) useSkill(refundsSkill);
			useTool({
				name: 'upgrade',
				description: 'Upgrade this customer to the pro tier.',
				run: () => {
					setPro(true);
					return 'upgraded';
				},
			});
			return 'Support agent.';
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
		await coordinator.admitDispatch(makeDispatchInput({ id: 'instance-skill-flip' }));
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// Zero skills at baseline: no activate_skill tool. The flip brings it.
		expect(baselineTools).not.toContain('activate_skill');
		expect(postFlipTools).toContain('activate_skill');
		// The flip narrated in the model's own context: delta line + roster.
		expect(postFlipMessages).toContain('New skill available:');
		expect(postFlipMessages).toContain(
			'- **refunds** — Process refund requests against the orders API.',
		);
		expect(postFlipMessages).toContain('All available skills: refunds');
		// Unknown names are a factual miss (the schema is a plain string now).
		// (The capture is JSON.stringify'd, so inner quotes arrive escaped.)
		expect(missMessages).toContain('Skill \\"nope\\" is not available. Available skills: refunds.');
		// The dynamic skill activates like any other.
		expect(briefingMessages).toContain('Verify the order, then issue the refund.');
		// The prompt's catalog is the frozen baseline (no skills at birth) —
		// the flip changed the conversation, never the system prompt.
		expect(finalSystemPrompt).not.toContain('## Available Skills');
	});

	it('narrates a deploy-time change at wake, before turn 1', async () => {
		const dbPath = createTempDbPath();
		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
		const provider = createFauxProvider();

		let deployed = false;
		function assistant() {
			if (deployed) {
				useTool({ name: 'beta', description: 'The new tool.', run: () => 'ok' });
			} else {
				useTool({ name: 'alpha', description: 'The old tool.', run: () => 'ok' });
			}
			return 'Deploy test agent.';
		}
		const definition = defineAgent(assistant, {
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
		});
		const makeCoordinator = () =>
			createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents: [{ name: 'assistant', definition }],
				createContext: makeFauxCreateContext(provider),
				conversationStreamStore,
				attachmentStore,
			});

		provider.setResponses([fauxAssistantMessage('First life.')]);
		const first = makeCoordinator();
		await first.admitDispatch(makeDispatchInput({ id: 'instance-deploy' }));
		await first.waitForIdle();
		await first.shutdown();

		// "Deploy": the same instance wakes under changed agent code.
		deployed = true;
		let wakeMessages: string | undefined;
		provider.setResponses([
			(context) => {
				wakeMessages = JSON.stringify(context.messages);
				return fauxAssistantMessage('Second life.');
			},
		]);
		const second = makeCoordinator();
		await second.admitDispatch(makeDispatchInput({ id: 'instance-deploy' }));
		await second.waitForIdle();
		await second.shutdown();

		// The wake diff narrated the swap before the model's first turn.
		expect(wakeMessages).toContain('New tool available:');
		expect(wakeMessages).toContain('- **beta** — The new tool.');
		expect(wakeMessages).toContain('The tool \\"alpha\\" is no longer available.');
		expect(wakeMessages).toContain('All available tools:');
	});

	it('rebaselines at compaction: the new prompt snapshots the current catalog', async () => {
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('upgrade', {}, { id: 'tool:up-2' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('upgraded'),
			fauxAssistantMessage('another turn'),
			// Compaction may split the tool turn: prefix + main summarization.
			fauxAssistantMessage('summary prefix'),
			fauxAssistantMessage('summary checkpoint'),
		]);
		const refundsSkill = defineSkill({
			name: 'refunds',
			description: 'Process refund requests against the orders API.',
			instructions: 'Verify the order, then issue the refund.',
		});
		function assistant() {
			const [pro, setPro] = usePersistentState('pro', false);
			if (pro) useSkill(refundsSkill);
			useTool({
				name: 'upgrade',
				description: 'Upgrade to pro.',
				run: () => {
					setPro(true);
					return 'upgraded';
				},
			});
			return 'Support agent.';
		}
		const model = provider.getModel();
		const ctx = createFlueContext({
			id: 'instance-rebaseline',
			env: {},
			agentConfig: {
				resolveModel: () => model,
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
		});
		const events: unknown[] = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(assistant, {
				model: `${model.provider}/${model.id}`,
				// Without a tiny keep-window the default swallows this short
				// history and manual compaction finds nothing to cut.
				compaction: { keepRecentTokens: 3 },
			}),
		);
		const session = await harness.session();

		await session.prompt('Upgrade me.');
		// Pre-compaction: the flip is live (skill declared) but the prompt's
		// catalog is still the frozen empty baseline.
		await session.prompt('Filler turn.');

		await session.compact();

		let postCompactPrompt: string | undefined;
		provider.setResponses([
			(context) => {
				postCompactPrompt = context.systemPrompt;
				return fauxAssistantMessage('Post-compaction turn.');
			},
		]);
		await session.prompt('What can you do now?');

		// Compaction actually ran (a no-op compact would leave the frozen
		// baseline in place and prove nothing).
		expect(events.some((event) => (event as { type: string }).type === 'compaction')).toBe(true);
		// The rebaselined prompt snapshots the current resource state — the
		// dynamic skill is in the catalog, first-message style.
		expect(postCompactPrompt).toContain('## Available Skills');
		expect(postCompactPrompt).toContain(
			'- **refunds** — Process refund requests against the orders API.',
		);
	});
});
