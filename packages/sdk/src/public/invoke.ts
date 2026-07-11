import type { HttpClient } from '../http.ts';

/** One image attachment on a `kind: 'user'` delivered message. */
export interface DeliveredAttachment {
	type: 'image';
	data: string;
	mimeType: string;
	/** Optional original filename, surfaced on the projected `file` part. */
	filename?: string;
}

/** Opaque, integrity-checked UTF-8 bytes visible only to the active model request. */
export interface OpaquePrivateContext {
	encoding: 'base64';
	data: string;
	sha256: string;
}

/**
 * The message delivered into an agent's session — the same unified shape the
 * server accepts from `dispatch()`. `kind: 'user'` is a direct user chat turn;
 * `kind: 'signal'` is a structured event (webhooks, schedules, multi-user
 * surfaces the agent participates in).
 */
export type DeliveredMessage =
	| {
			kind: 'user';
			body: string;
			attachments?: DeliveredAttachment[];
			privateContext?: OpaquePrivateContext;
	  }
	| {
			kind: 'signal';
			type: string;
			body: string;
			attributes?: Record<string, string>;
			tagName?: string;
			privateContext?: OpaquePrivateContext;
	  };

/** Options for one direct-agent prompt. */
export interface AgentPromptOptions {
	message: DeliveredMessage;
	signal?: AbortSignal;
}

/** Result of admitting one agent prompt. All fields are server-provided. */
export interface AgentSendResult {
	/** Fully resolved DS-compatible stream URL for observing the agent instance's events. */
	streamUrl: string;
	/**
	 * Opaque DS stream offset captured at admission. Reading `streamUrl` from
	 * this offset yields exactly this prompt's events.
	 */
	offset: string;
	/** Correlates the admitted prompt with its attached agent events. */
	submissionId: string;
}

export async function sendAgent(
	http: HttpClient,
	name: string,
	id: string,
	options: AgentPromptOptions,
): Promise<AgentSendResult> {
	return http.json<AgentSendResult>({
		method: 'POST',
		path: `/agents/${encodeURIComponent(name)}/${encodeURIComponent(id)}`,
		body: options.message,
		signal: options.signal,
	});
}
