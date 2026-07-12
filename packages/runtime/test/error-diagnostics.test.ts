import type { AssistantMessage } from '@earendil-works/pi-ai/compat';
import { describe, expect, it } from 'vitest';
import { isAssistantContextOverflow } from '../src/compaction.ts';
import {
	CloudflareAIBindingError,
	ConversationRecordInvariantError,
	FlueError,
	OperationFailedError,
	serializeEventError,
} from '../src/errors.ts';

// Telemetry-facing error diagnostics. Each behavior here was a filed defect
// against the beta line (withastro/flue#424, #428, #431): dropping these
// fields made real incidents undiagnosable from the event stream, and the
// overflow marker is what lets provider-overflow classification (and with it
// compaction recovery) fire on Cloudflare AI binding 413s.

describe('CloudflareAIBindingError', () => {
	it('carries the provider body in the message, not just details', () => {
		const error = new CloudflareAIBindingError({
			status: 502,
			statusText: 'Bad Gateway',
			body: 'request aborted by upstream',
		});
		expect(error.message).toBe(
			'Cloudflare AI binding request failed with 502 Bad Gateway: request aborted by upstream',
		);
		expect(error.details).toBe('Provider response: request aborted by upstream');
	});

	it('marks 413 responses with (request_too_large) so overflow classification matches', () => {
		const error = new CloudflareAIBindingError({
			status: 413,
			statusText: 'Payload Too Large',
			body: '{"error":"content length exceeded"}',
		});
		expect(error.message).toMatch(/request_too_large/);
		expect(error.message).toContain('content length exceeded');

		// The marker does not depend on the provider sending a body.
		const bodyless = new CloudflareAIBindingError({ status: 413 });
		expect(bodyless.message).toMatch(/request_too_large/);
	});

	it('carries a structured request_too_large reason in meta on 413 only', () => {
		const overflow = new CloudflareAIBindingError({
			status: 413,
			statusText: 'Payload Too Large',
		});
		expect(overflow.meta).toEqual({
			status: 413,
			statusText: 'Payload Too Large',
			reason: 'request_too_large',
		});

		const outage = new CloudflareAIBindingError({ status: 502, statusText: 'Bad Gateway' });
		expect(outage.meta).toEqual({ status: 502, statusText: 'Bad Gateway' });
	});

	it('bounds an oversized provider body in the message while details keeps it whole', () => {
		const body = 'x'.repeat(5000);
		const error = new CloudflareAIBindingError({ status: 500, body });
		expect(error.message.length).toBeLessThan(2200);
		expect(error.message).toContain('[truncated]');
		expect(error.details).toBe(`Provider response: ${body}`);
	});

	it('leaves an explicit message untouched', () => {
		const error = new CloudflareAIBindingError({
			message: 'Cloudflare AI binding returned empty response body.',
		});
		expect(error.message).toBe('Cloudflare AI binding returned empty response body.');
	});
});

describe('isAssistantContextOverflow', () => {
	const erroredAssistant = (errorMessage: string): AssistantMessage =>
		({
			role: 'assistant',
			content: [],
			stopReason: 'error',
			errorMessage,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		}) as unknown as AssistantMessage;

	it('classifies a binding 413 structurally, past pi-ai non-overflow precedence', () => {
		// A provider body mentioning rate limiting matches pi-ai's
		// NON_OVERFLOW_PATTERNS, which would veto its pattern-based
		// classification — the runtime's own marker must still win.
		const message = new CloudflareAIBindingError({
			status: 413,
			statusText: 'Payload Too Large',
			body: 'request rejected: rate limit on payload size',
		}).message;
		expect(isAssistantContextOverflow(erroredAssistant(message), 128_000)).toBe(true);
	});

	it('still delegates provider-pattern overflow to pi-ai', () => {
		expect(isAssistantContextOverflow(erroredAssistant('prompt is too long: 250000 tokens'), 128_000)).toBe(
			true,
		);
	});

	it('does not classify an ordinary binding failure as overflow', () => {
		const message = new CloudflareAIBindingError({
			status: 502,
			statusText: 'Bad Gateway',
			body: 'upstream reset',
		}).message;
		expect(isAssistantContextOverflow(erroredAssistant(message), 128_000)).toBe(false);
	});
});

describe('OperationFailedError', () => {
	it('forwards the unwrapped operation and reason in meta', () => {
		const error = new OperationFailedError({
			operation: 'dispatch(sub_01ABC)',
			reason: 'Submission exceeded the configured timeout.',
		});
		expect(error.message).toBe(
			'dispatch(sub_01ABC) failed: Submission exceeded the configured timeout.',
		);
		expect(error.meta).toEqual({
			operation: 'dispatch(sub_01ABC)',
			reason: 'Submission exceeded the configured timeout.',
		});
	});
});

describe('serializeEventError', () => {
	it('keeps type, details, and meta for FlueErrors', () => {
		const error = new ConversationRecordInvariantError({
			recordId: 'rec_1',
			recordType: 'user_message',
			reason: 'duplicate record id',
		});
		const serialized = serializeEventError(error) as Record<string, unknown>;
		expect(serialized.name).toBe(error.name);
		expect(serialized.message).toBe(error.message);
		expect(serialized.type).toBe(error.type);
		expect(serialized.meta).toEqual(error.meta);
		expect(error).toBeInstanceOf(FlueError);
	});

	it('serializes plain Errors to name/message and passes non-errors through', () => {
		expect(serializeEventError(new Error('boom'))).toEqual({ name: 'Error', message: 'boom' });
		expect(serializeEventError('boom')).toBe('boom');
	});
});
