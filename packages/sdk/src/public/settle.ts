import type { BackoffOptions } from '@durable-streams/client';
import type { HttpClient } from '../http.ts';
import {
	assertConversationStreamChunk,
	type ConversationStreamChunk,
} from './conversation-stream.ts';
import type { AgentSendResult } from './send.ts';
import { createFlueEventStream } from './stream.ts';

export interface AgentWaitOptions {
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
	/**
	 * Invoked for each conversation stream chunk while waiting, for progress
	 * rendering. Prefer `observe()` for maintained UI state.
	 */
	onEvent?: (event: ConversationStreamChunk) => void | Promise<void>;
}

export type FlueExecutionTarget = 'agent_submission';
export type FlueExecutionFailure = 'failed' | 'aborted' | 'terminal_event_missing';

export class FlueExecutionError extends Error {
	readonly target: FlueExecutionTarget;
	readonly targetId: string;
	readonly failure: FlueExecutionFailure;
	readonly error: unknown;

	constructor(options: {
		target: FlueExecutionTarget;
		targetId: string;
		failure: FlueExecutionFailure;
		error?: unknown;
	}) {
		super(executionErrorMessage(options));
		this.name = 'FlueExecutionError';
		this.target = options.target;
		this.targetId = options.targetId;
		this.failure = options.failure;
		this.error = options.error;
	}
}

export async function waitForAgentSubmission(
	http: HttpClient,
	admission: AgentSendResult,
	options: AgentWaitOptions = {},
): Promise<void> {
	const url = new URL(admission.streamUrl);
	url.searchParams.set('view', 'updates');
	const stream = createFlueEventStream<ConversationStreamChunk>(
		{
			offset: admission.offset,
			signal: options.signal,
			backoffOptions: options.backoffOptions,
		},
		{ url: url.toString(), fetch: http.fetchWithHeaders.bind(http) },
		assertConversationStreamChunk,
	);

	for await (const chunk of stream) {
		await options.onEvent?.(chunk);
		throwIfAborted(options.signal);
		if (chunk.type !== 'submission-settled') continue;
		if (chunk.submissionId !== admission.submissionId) continue;
		if (chunk.outcome === 'completed') return;
		throw new FlueExecutionError({
			target: 'agent_submission',
			targetId: admission.submissionId,
			failure: chunk.outcome === 'aborted' ? 'aborted' : 'failed',
			error: chunk.error,
		});
	}

	throwIfAborted(options.signal);
	throw new FlueExecutionError({
		target: 'agent_submission',
		targetId: admission.submissionId,
		failure: 'terminal_event_missing',
	});
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function executionErrorMessage(options: {
	targetId: string;
	failure: FlueExecutionFailure;
	error?: unknown;
}): string {
	if (options.failure === 'terminal_event_missing') {
		return `Agent submission ${options.targetId} ended without a terminal event`;
	}
	const message = errorMessage(options.error);
	const verb = options.failure === 'aborted' ? 'was aborted' : 'failed';
	return `Agent submission ${options.targetId} ${verb}${message ? `: ${message}` : ''}`;
}

function errorMessage(error: unknown): string | undefined {
	if (typeof error === 'string') return error;
	if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
	return typeof error.message === 'string' ? error.message : undefined;
}
