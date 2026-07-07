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
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	buildConversationContext,
	createReducedInstanceState,
	getActiveConversationPath,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';
import { renderWithFrame } from '../src/hooks/frame.ts';
import { renderAgentFunctionWithStructure } from '../src/hooks/render.ts';
import { useAppend } from '../src/hooks/use-append.ts';
import { useTool } from '../src/hooks/use-tool.ts';
import { createFlueContext, type DispatchInput } from '../src/internal.ts';
import type { AgentSignalAppend } from '../src/message-output.ts';
import { createNodeAgentCoordinator } from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
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
		provider: `agent-append-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-agent-append-'));
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

async function connectSqlite(dbPath: string) {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	return adapter.connect();
}

function readDurableRecords(dbPath: string): ConversationRecord[] {
	const db = new DatabaseSync(dbPath);
	const rows = db
		.prepare('SELECT data FROM flue_conversation_stream_batches ORDER BY seq')
		.all() as Array<{ data: string }>;
	db.close();
	return rows.flatMap((row) => JSON.parse(row.data) as ConversationRecord[]);
}

const CONFIG = { model: 'faux/agent-append' };

describe('useAppend()', () => {
	it('rejects appends made during render', () => {
		expect(() =>
			renderAgentFunctionWithStructure(() => {
				const append = useAppend();
				append({ type: 'note', body: 'Rendered.' });
				return 'Base.';
			}, CONFIG),
		).toThrow(/called during render/);
	});

	it('is unavailable in subagent renders', () => {
		expect(() =>
			renderWithFrame(
				() => {
					useAppend();
				},
				undefined,
				'subagent',
			),
		).toThrow(/not available in a subagent render/);
	});

	it('throws on append when no durable runtime backs the render', () => {
		let append: ((signal: AgentSignalAppend) => void) | undefined;
		renderAgentFunctionWithStructure(() => {
			append = useAppend();
			return 'Base.';
		}, CONFIG);
		expect(() => append?.({ type: 'note', body: 'Unbacked.' })).toThrow(
			/no durable runtime behind this render/,
		);
	});

	it('rejects invalid signals at the append call', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('poke', {}, { id: 'tool-poke-1' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage('Done.'),
		]);

		const failures: string[] = [];
		function assistant() {
			const append = useAppend();
			useTool({
				name: 'poke',
				description: 'Attempt a set of invalid appends.',
				run: () => {
					for (const bad of [
						{ type: '', body: 'empty type' },
						{ type: 'note', body: 'bad tag', tagName: '1nope' },
						{ type: 'note', body: 'unknown field', extra: true } as unknown as AgentSignalAppend,
					]) {
						try {
							append(bad as AgentSignalAppend);
							failures.push('accepted');
						} catch (error) {
							failures.push(error instanceof Error ? error.message : String(error));
						}
					}
					return 'ok';
				},
			});
			return 'Validator agent.';
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
		await coordinator.admitDispatch({
			dispatchId: 'dispatch:append-invalid-1',
			agent: 'assistant',
			id: 'instance-invalid',
			message: { kind: 'user', body: 'Validate.' },
			acceptedAt: new Date().toISOString(),
		} satisfies DispatchInput);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		expect(failures).toHaveLength(3);
		expect(failures[0]).toMatch(/"type" must not be empty/);
		expect(failures[1]).toMatch(/valid XML tag name/);
		expect(failures[2]).toMatch(/unknown signal field/);
		// None of the rejected appends left a durable trace.
		expect(readDurableRecords(dbPath).some((record) => record.type === 'signal')).toBe(false);
	});

	it('appends from a tool reach the model at the next turn and land durably after the tool batch', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();

		// Turn 2's request context is the live in-memory loop state — capture it
		// to prove the steered signal reached the model without any rebuild.
		let turnTwoTexts: string[] | undefined;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('run_intake', {}, { id: 'tool-intake-1' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				turnTwoTexts = context.messages.map((message) =>
					typeof message.content === 'string'
						? message.content
						: message.content
								.map((block) => ('text' in block ? block.text : `[${block.type}]`))
								.join('\n'),
				);
				return fauxAssistantMessage('Proceeding with reproduce.');
			},
		]);

		function assistant() {
			const append = useAppend();
			useTool({
				name: 'run_intake',
				description: 'Load the issue and announce the intake result.',
				run: () => {
					append({
						type: 'intake',
						body: 'Issue #42 loaded; triage warranted.',
						attributes: { issue: '42' },
					});
					append({ type: 'phase', body: 'Entering reproduce.' });
					return 'Intake complete.';
				},
			});
			return 'Triage agent.';
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
		await coordinator.admitDispatch({
			dispatchId: 'dispatch:append-1',
			agent: 'assistant',
			id: 'instance-append',
			message: { kind: 'user', body: 'Triage issue #42.' },
			acceptedAt: new Date().toISOString(),
		} satisfies DispatchInput);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		// The model saw both signals on turn two, rendered as signal tags, in
		// call order, after the tool result.
		expect(turnTwoTexts).toBeDefined();
		const joined = (turnTwoTexts ?? []).join('\n---\n');
		expect(joined).toContain('<signal type="intake" issue="42">');
		expect(joined).toContain('Issue #42 loaded; triage warranted.');
		expect(joined).toContain('<signal type="phase">');
		expect(joined.indexOf('type="intake"')).toBeLessThan(joined.indexOf('type="phase"'));

		// Durable side: two signal records, in order, carrying the submission but
		// no dispatchId (they were authored by code, not delivered).
		const records = readDurableRecords(dbPath);
		const signalRecords = records.flatMap((record) =>
			record.type === 'signal' && record.signalType !== 'issue.triage' ? [record] : [],
		);
		expect(signalRecords.map((record) => record.signalType)).toEqual(['intake', 'phase']);
		for (const record of signalRecords) {
			expect(record.submissionId).toBeDefined();
			expect(record.dispatchId).toBeUndefined();
			expect(record.turnId).toBeDefined();
		}
		expect(signalRecords[0]?.attributes).toEqual({ issue: '42' });

		// Topology: on the active path the signals sit between the tool result
		// and the final assistant message — the exact position the live loop
		// injected them.
		const reduced = reduceConversationRecords(createReducedInstanceState(), records);
		const conversation = [...reduced.conversations.values()][0];
		expect(conversation).toBeDefined();
		if (!conversation) throw new Error('no conversation');
		const kinds = getActiveConversationPath(conversation).map((entry) =>
			entry.type === 'message'
				? entry.message.role === 'signal'
					? `signal:${entry.message.type}`
					: entry.message.role
				: entry.type,
		);
		expect(kinds).toEqual([
			'user',
			'assistant',
			'toolResult',
			'signal:intake',
			'signal:phase',
			'assistant',
		]);

		// The rebuilt model context renders the signals identically to what the
		// live loop steered in — a resumed or next run can never disagree with
		// what the model already saw.
		const rebuilt = buildConversationContext(conversation)
			.map((message) => {
				if (!('content' in message)) return `[${message.role}]`;
				const content = message.content as string | Array<{ text?: string; type: string }>;
				return typeof content === 'string'
					? content
					: content.map((block) => block.text ?? `[${block.type}]`).join('\n');
			})
			.join('\n---\n');
		expect(rebuilt).toContain('<signal type="intake" issue="42">');
		expect(rebuilt.indexOf('type="intake"')).toBeLessThan(rebuilt.indexOf('type="phase"'));
	});

	it('throws when the agent is idle — appends are annotations, not deliveries', async () => {
		const dbPath = createTempDbPath();
		const { executionStore, conversationStreamStore, attachmentStore } =
			await connectSqlite(dbPath);
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Done.')]);

		let append: ((signal: AgentSignalAppend) => void) | undefined;
		function assistant() {
			append = useAppend();
			return 'Quiet agent.';
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
		await coordinator.admitDispatch({
			dispatchId: 'dispatch:append-idle-1',
			agent: 'assistant',
			id: 'instance-idle',
			message: { kind: 'user', body: 'Hello.' },
			acceptedAt: new Date().toISOString(),
		} satisfies DispatchInput);
		await coordinator.waitForIdle();

		expect(append).toBeDefined();
		expect(() => append?.({ type: 'late', body: 'Too late.' })).toThrow(
			/only legal while the agent is responding/,
		);
		await coordinator.shutdown();
		expect(readDurableRecords(dbPath).some((record) => record.type === 'signal')).toBe(false);
	});
});
