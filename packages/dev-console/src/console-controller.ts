import type { ConversationStreamChunk, DeliveredAttachment, FlueClient } from '@flue/sdk';
import {
	type ConsoleTranscript,
	createConsoleTranscript,
	reduceConsoleTranscript,
	type TranscriptAction,
} from './console-transcript.ts';

type ConsoleStatus = 'ready' | 'active' | 'completed' | 'failed' | 'closing' | 'closed';

export interface ConsoleQueuedPrompt {
	readonly id: number;
	readonly message: string;
}

interface ConsoleSnapshot {
	/** The conversation URL the console is attached to. */
	readonly url: string;
	readonly status: ConsoleStatus;
	readonly active: boolean;
	readonly composerEnabled: boolean;
	readonly queuedPrompts: readonly ConsoleQueuedPrompt[];
	readonly transcript: ConsoleTranscript;
}

export interface ConsoleControllerOptions {
	readonly client: FlueClient;
	readonly initialInput?: unknown;
}

export interface ConsoleController {
	readonly subscribe: (listener: () => void) => () => void;
	readonly getSnapshot: () => ConsoleSnapshot;
	start(): Promise<void>;
	submit(message: string): Promise<void>;
	close(): Promise<void>;
	forceCloseSync(): void;
}

interface AgentInput {
	message: string;
	images?: DeliveredAttachment[];
}

export function createConsoleController(options: ConsoleControllerOptions): ConsoleController {
	const listeners = new Set<() => void>();
	let snapshot: ConsoleSnapshot = {
		url: options.client.url,
		status: 'ready',
		active: false,
		composerEnabled: true,
		queuedPrompts: [],
		transcript: createConsoleTranscript(),
	};
	let nextQueuedPromptId = 1;
	let started: Promise<void> | undefined;
	let closePromise: Promise<void> | undefined;
	let admissionQueue = Promise.resolve();
	const activeControllers = new Set<AbortController>();
	const inFlight = new Set<Promise<void>>();
	let batchFailed = false;
	let closing = false;

	const publish = (next: Partial<ConsoleSnapshot>, action?: TranscriptAction) => {
		snapshot = {
			...snapshot,
			...next,
			transcript: action ? reduceConsoleTranscript(snapshot.transcript, action) : snapshot.transcript,
		};
		for (const listener of listeners) listener();
	};

	const controller: ConsoleController = {
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		getSnapshot: () => snapshot,
		start() {
			if (started) return started;
			started = start();
			return started;
		},
		submit(message) {
			if (closing) throw new Error('Console is closing.');
			const queuedPrompt = enqueuePrompt(message);
			return trackExecution(execute({ message }, queuedPrompt));
		},
		close() {
			if (closePromise) return closePromise;
			closing = true;
			closePromise = (async () => {
				publish({ status: 'closing', composerEnabled: false, queuedPrompts: [] }, { type: 'clear-streaming' });
				for (const activeController of activeControllers) activeController.abort();
				await Promise.allSettled([...inFlight]);
				publish({ status: 'closed', active: false });
			})();
			return closePromise;
		},
		forceCloseSync() {
			closing = true;
			for (const activeController of activeControllers) activeController.abort();
		},
	};
	return controller;

	async function start(): Promise<void> {
		if (options.initialInput === undefined) return;
		const input = parseAgentInput(options.initialInput);
		const queuedPrompt = enqueuePrompt(input.message);
		await trackExecution(execute(input, queuedPrompt));
	}

	function trackExecution(execution: Promise<void>): Promise<void> {
		if (inFlight.size === 0) batchFailed = false;
		inFlight.add(execution);
		void execution.then(
			() => inFlight.delete(execution),
			() => inFlight.delete(execution),
		);
		return execution;
	}

	function enqueuePrompt(message: string): ConsoleQueuedPrompt {
		const queuedPrompt = { id: nextQueuedPromptId++, message };
		publish({ queuedPrompts: [...snapshot.queuedPrompts, queuedPrompt] });
		return queuedPrompt;
	}

	function removeQueuedPrompt(queuedPrompt: ConsoleQueuedPrompt): readonly ConsoleQueuedPrompt[] {
		return snapshot.queuedPrompts.filter((prompt) => prompt.id !== queuedPrompt.id);
	}

	async function execute(input: AgentInput, queuedPrompt: ConsoleQueuedPrompt): Promise<void> {
		if (closing) return;
		const activeController = new AbortController();
		activeControllers.add(activeController);
		publish({ status: 'active', active: true });
		let failed = false;
		let promptStarted = false;
		const onEvent = (event: ConversationStreamChunk): void => {
			if (closing) return;
			if (!promptStarted) {
				promptStarted = true;
				publish(
					{ queuedPrompts: removeQueuedPrompt(queuedPrompt) },
					{ type: 'prompt', message: queuedPrompt.message },
				);
			}
			publish({}, { type: 'event', event });
		};
		try {
			await runPrompt(input, onEvent, activeController.signal);
			if (closing) return;
			if (!promptStarted) {
				publish(
					{ queuedPrompts: removeQueuedPrompt(queuedPrompt) },
					{ type: 'prompt', message: queuedPrompt.message },
				);
			}
		} catch (error) {
			failed = !activeController.signal.aborted;
			if (failed) batchFailed = true;
			if (!closing && failed) {
				publish(
					!promptStarted ? { queuedPrompts: removeQueuedPrompt(queuedPrompt) } : {},
					{ type: 'error', error },
				);
			}
		} finally {
			activeControllers.delete(activeController);
			if (!closing) {
				const active = activeControllers.size > 0;
				publish({
					status: active ? 'active' : batchFailed ? 'failed' : 'completed',
					active,
				});
			}
		}
	}

	async function runPrompt(
		input: AgentInput,
		onEvent: (event: ConversationStreamChunk) => void,
		signal: AbortSignal,
	): Promise<void> {
		const admission = admissionQueue.then(() => {
			signal.throwIfAborted();
			return options.client.send({
				message: {
					kind: 'user',
					body: input.message,
					...(input.images?.length ? { attachments: input.images } : {}),
				},
				signal,
			});
		});
		admissionQueue = admission.then(() => undefined, () => undefined);
		const admitted = await admission;
		await options.client.wait(admitted, { onEvent, signal });
	}
}

function parseAgentInput(value: unknown): AgentInput {
	if (!isRecord(value) || typeof value.message !== 'string') {
		throw new TypeError('Agent input must be an object with a string "message" field.');
	}
	const keys = Object.keys(value);
	if (keys.some((key) => key !== 'message' && key !== 'images')) {
		throw new TypeError('Agent input accepts only "message" and optional "images" fields.');
	}
	if (value.images !== undefined && !isAgentImages(value.images)) {
		throw new TypeError('Agent input "images" must be an array of image objects.');
	}
	return value.images === undefined
		? { message: value.message }
		: { message: value.message, images: value.images };
}

function isAgentImages(value: unknown): value is DeliveredAttachment[] {
	return Array.isArray(value) && value.every((image) =>
		isRecord(image)
		&& image.type === 'image'
		&& typeof image.data === 'string'
		&& typeof image.mimeType === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
