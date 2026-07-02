import type { FlueClient, FlueConversationMessage } from '@flue/sdk';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFlueAgent } from '../src/use-agent.ts';
import { conversation, createFakeObservation } from './fixtures/observation.ts';

function client(overrides: Partial<FlueClient>): FlueClient {
	return { url: 'https://flue.test/agents/agent/id', ...overrides } as FlueClient;
}

describe('useFlueAgent()', () => {
	const historyMessages: FlueConversationMessage[] = [
		{
			id: 'entry-user',
			role: 'user',
			purpose: 'user',
			display: 'visible',
			submissionId: 'submission-1',
			parts: [{ type: 'text', text: 'history', state: 'done' }],
		},
	];

	it('reports history ready only after the observed transcript is available', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const flue = client({ observe });
		const { result, unmount } = renderHook(() => useFlueAgent({ client: flue }));

		expect(result.current.historyReady).toBe(false);
		expect(result.current.messages).toEqual([]);

		act(() =>
			observation.emit({
				conversation: conversation(historyMessages),
				offset: 'offset-history',
				phase: 'live',
				error: undefined,
			}),
		);
		await waitFor(() => expect(result.current.historyReady).toBe(true));
		expect(result.current.messages[0]?.id).toBe('entry-user');
		unmount();
	});

	it('forwards the configured live mode to observe()', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const flue = client({ observe });
		const { unmount } = renderHook(() => useFlueAgent({ client: flue, live: 'long-poll' }));

		await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
		expect(observe).toHaveBeenCalledWith({ live: 'long-poll' });
		unmount();
	});

	it('defaults to sse live mode for smoother streaming when none is configured', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const flue = client({ observe });
		const { unmount } = renderHook(() => useFlueAgent({ client: flue }));

		await waitFor(() => expect(observe).toHaveBeenCalledTimes(1));
		expect(observe).toHaveBeenCalledWith({ live: 'sse' });
		unmount();
	});

	it('stays dormant without a conversation url or client', async () => {
		const { result } = renderHook(() => useFlueAgent());

		expect(result.current.status).toBe('idle');
		expect(result.current.historyReady).toBe(false);
		expect(result.current.messages).toEqual([]);
		await expect(result.current.sendMessage('hello')).rejects.toThrow(
			'cannot send without a conversation url',
		);
	});

	it('submits optimistically and reconciles canonical user identity', async () => {
		const observation = createFakeObservation();
		const observe = vi.fn().mockReturnValue(observation);
		const send = vi.fn().mockResolvedValue({
			streamUrl: 'https://flue.test/agents/agent/id',
			offset: 'offset-history',
			submissionId: 'submission-1',
		});
		const flue = client({ observe, send });
		const { result } = renderHook(() => useFlueAgent({ client: flue }));

		act(() =>
			observation.emit({
				conversation: conversation(),
				offset: 'offset-history',
				phase: 'live',
				error: undefined,
			}),
		);
		await waitFor(() => expect(result.current.historyReady).toBe(true));

		await act(async () => result.current.sendMessage('hello'));
		expect(result.current.status).toBe('submitted');
		expect(result.current.messages[0]?.parts[0]).toMatchObject({ type: 'text', text: 'hello' });
		expect(send).toHaveBeenCalledWith({ message: { kind: 'user', body: 'hello' } });

		act(() =>
			observation.emit({
				conversation: conversation([
					{
						id: 'entry-user',
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
			}),
		);
		await waitFor(() => expect(result.current.messages).toHaveLength(1));
		// The canonical user message is re-keyed to the optimistic local id so the
		// row stays stable across the optimistic→confirmed swap.
		expect(result.current.messages[0]?.id).toBe('local:1');
	});
});
