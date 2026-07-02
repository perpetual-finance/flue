import type { FlueClient } from '@flue/sdk';
import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../src/agent-session.ts';
import { conversation, createFakeObservation } from './fixtures/observation.ts';

function client(overrides: Partial<FlueClient>): FlueClient {
	return { url: 'https://flue.test/agents/agent/id', ...overrides } as FlueClient;
}

describe('AgentSession', () => {
	it('projects an observed snapshot before applying observed live updates', () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const session = new AgentSession(client({ observe }));

		session.start();
		expect(observe).toHaveBeenCalledWith({ live: 'sse' });

		observation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					submissionId: 'submission-1',
					parts: [{ type: 'text', text: 'first', state: 'done' }],
				},
			]),
			offset: 'offset-history',
			phase: 'live',
			error: undefined,
		});

		expect(session.getSnapshot()).toMatchObject({
			historyReady: true,
			messages: [{ id: 'entry-user' }],
		});

		observation.emit({
			conversation: conversation([
				{
					id: 'entry-user',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					submissionId: 'submission-1',
					parts: [{ type: 'text', text: 'first', state: 'done' }],
				},
				{ id: 'entry-assistant', role: 'assistant', purpose: 'assistant', display: 'visible', parts: [], metadata: { model: { provider: 'test', id: 'model' } } },
			]),
			offset: 'offset-2',
			phase: 'live',
			error: undefined,
		});

		expect(session.getSnapshot().messages.map((message) => message.id)).toEqual([
			'entry-user',
			'entry-assistant',
		]);
		session.dispose();
		expect(observation.close).toHaveBeenCalled();
	});

	it('resumes the observation when refresh() is called for an absent conversation', () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const session = new AgentSession(client({ observe }));

		session.start();
		observation.emit({ conversation: undefined, offset: undefined, phase: 'absent', error: undefined });

		// The application decides when to re-check a conversation that does not
		// exist yet; refresh() re-runs the observation's history catch-up.
		session.refresh();
		expect(observation.refresh).toHaveBeenCalledTimes(1);

		session.dispose();
	});

	it('reconciles an optimistic send with canonical user-message identity', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-history',
			submissionId: 'submission-1',
		});
		const session = new AgentSession(client({ observe, send }));

		session.start();
		observation.emit({
			conversation: conversation(),
			offset: 'offset-history',
			phase: 'live',
			error: undefined,
		});
		await session.sendMessage('hello');
		expect(session.getSnapshot().status).toBe('submitted');
		expect(send).toHaveBeenCalledWith({ message: { kind: 'user', body: 'hello' } });

		observation.emit({
			conversation: conversation([
				{
					id: 'entry-canonical-user',
					role: 'user',
					purpose: 'user',
					display: 'visible',
					submissionId: 'submission-1',
					parts: [{ type: 'text', text: 'hello', state: 'done' }],
				},
			]),
			offset: 'offset-2',
			phase: 'live',
			error: undefined,
		});

		// The canonical user message adopts the optimistic local id, so the row is
		// stable across the optimistic→confirmed swap.
		expect(session.getSnapshot().messages).toHaveLength(1);
		expect(session.getSnapshot().messages[0]?.id).toBe('local:1');
		session.dispose();
	});
});
