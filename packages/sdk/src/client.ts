import { stream as dsStream } from '@durable-streams/client';
import { HttpClient, type HttpClientOptions, type RequestHeaders } from './http.ts';
export type { HttpClientOptions } from './http.ts';
import {
	type AgentPromptOptions,
	promptAgent,
	sendAgent,
	type AgentPromptResult,
} from './public/invoke.ts';
import {
	createFlueEventStream,
	type FlueEventStream,
	type FlueStreamOptions,
} from './public/stream.ts';
import type { AttachedAgentEvent, FlueEvent, RunRecord } from './types.ts';

export type { RequestHeaders };

/** Options for starting a workflow run. */
export interface WorkflowInvokeOptions {
	/** Workflow-defined payload. */
	payload?: unknown;
	signal?: AbortSignal;
}

/** Result of starting a workflow run. */
export interface WorkflowInvokeResult {
	/** The workflow run ID. */
	runId: string;
	/** Fully resolved DS-compatible stream URL for observing run events. */
	streamUrl: string;
}

/** Options for creating a client for deployed Flue application routes. */
export type CreateFlueClientOptions = HttpClientOptions;

/** Client for invoking deployed agents and workflows and inspecting workflow runs. */
export interface FlueClient {
	/** Direct interactions with persistent agent instances. */
	agents: {
		/** Resolves the terminal result for one agent prompt. */
		prompt(name: string, id: string, options: AgentPromptOptions): Promise<AgentPromptResult>;
		send(name: string, id: string, options: AgentPromptOptions): Promise<{ streamUrl: string; offset: string }>;
		/** Stream events from an agent instance via the Durable Streams protocol. */
		stream(name: string, id: string, options?: FlueStreamOptions): FlueEventStream<AttachedAgentEvent>;
	};
	/** Workflow-run inspection and streaming APIs. */
	runs: {
		/** Retrieves one workflow-run record via the `?meta` view of the run route. */
		get(runId: string): Promise<RunRecord>;
		/** Stream events from a workflow run via the Durable Streams protocol. */
		stream(runId: string, options?: FlueStreamOptions): FlueEventStream<FlueEvent>;
		/** Get all events from a workflow run as an array (catch-up read, no live tailing). */
		events(runId: string, options?: { offset?: string; signal?: AbortSignal; backoffOptions?: import('@durable-streams/client').BackoffOptions }): Promise<FlueEvent[]>;
	};
	/** Start workflow runs. */
	workflows: {
		/** Start a workflow run. Returns the run ID and stream URL. */
		invoke(name: string, options?: WorkflowInvokeOptions): Promise<WorkflowInvokeResult>;
	};
}

/** Creates a client for the public routes of a deployed Flue application. */
export function createFlueClient(options: CreateFlueClientOptions): FlueClient {
	const http = new HttpClient(options);
	return {
		agents: {
			prompt: (name, id, opts) => promptAgent(http, name, id, opts),
			send: (name, id, opts) => sendAgent(http, name, id, opts),
			stream: (name, id, opts = {}) =>
				createFlueEventStream<AttachedAgentEvent>(opts, {
					url: http.url(`/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`),
					fetch: http.fetchWithHeaders.bind(http),
				}),
		},
		runs: {
			get: (runId) =>
				http.json<RunRecord>({ path: `/runs/${encodeURIComponent(runId)}?meta` }),
			stream: (runId, opts = {}) =>
				createFlueEventStream<FlueEvent>(opts, {
					url: http.url(`/runs/${encodeURIComponent(runId)}`),
					fetch: http.fetchWithHeaders.bind(http),
				}),
			events: async (runId, opts) => {
				const url = http.url(`/runs/${encodeURIComponent(runId)}`);
				const events: FlueEvent[] = [];
				let offset = opts?.offset ?? '-1';
				// The DS client makes exactly one request per `live: false` stream,
				// even when the server caps the catch-up batch and reports more data
				// remains (no Stream-Up-To-Date header). Loop until up-to-date.
				for (;;) {
					const res = await dsStream<FlueEvent>({
						url,
						offset,
						live: false,
						json: true,
						signal: opts?.signal,
						backoffOptions: opts?.backoffOptions,
						fetch: http.fetchWithHeaders.bind(http),
						warnOnHttp: false,
					});
					events.push(...(await readJsonWithAbort<FlueEvent[]>(res, opts?.signal)));
					if (res.upToDate || res.offset === offset) break;
					offset = res.offset;
				}
				return events;
			},

		},
		workflows: {
			invoke: async (name, opts) => {
				const body = await http.json<{ status: string; runId: string }>({
					method: 'POST',
					path: `/workflows/${encodeURIComponent(name)}`,
					body: opts?.payload,
					signal: opts?.signal,
				});
				return {
					runId: body.runId,
					streamUrl: http.url(`/runs/${encodeURIComponent(body.runId)}`),
				};
			},
		},
	};
}

async function readJsonWithAbort<T>(response: { json(): Promise<T> }, signal?: AbortSignal): Promise<T> {
	const result = await response.json();
	if (signal?.aborted) {
		throw signal.reason ?? new DOMException('Aborted', 'AbortError');
	}
	return result;
}
