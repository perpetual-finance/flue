import { InvalidRequestError } from '../errors.ts';
import type { DeliveredMessage, OpaquePrivateContext } from '../types.ts';
import { MAX_PRIVATE_CONTEXT_BYTES } from './schemas.ts';

/** Exact capability token callers can preflight before sending private context. */
export const PRIVATE_CONTEXT_CAPABILITY = 'work-studio.private-context.v1' as const;
export const PRIVATE_CONTEXT_SYSTEM_SEPARATOR = '\n\n';
export const PRIVATE_CONTEXT_REQUEST_OVERHEAD_TOKENS = 256;

export function maximumPrivateContextRecentTokens(input: {
	contextWindow: number;
	reserveTokens: number;
	configuredKeepRecentTokens: number;
	privateContextByteLength: number;
	systemPromptByteLength: number;
}): number {
	if (input.contextWindow <= 0 || input.privateContextByteLength <= 0) {
		return input.configuredKeepRecentTokens;
	}
	const available =
		input.contextWindow -
		input.reserveTokens -
		input.privateContextByteLength -
		input.systemPromptByteLength -
		new TextEncoder().encode(PRIVATE_CONTEXT_SYSTEM_SEPARATOR).byteLength -
		PRIVATE_CONTEXT_REQUEST_OVERHEAD_TOKENS;
	return Math.max(1, Math.min(input.configuredKeepRecentTokens, available));
}

function invalidPrivateContext(reason: string): never {
	throw new InvalidRequestError({ reason: `Invalid private context: ${reason}` });
}

function decodeCanonicalBase64(data: string): Uint8Array {
	let binary: string;
	try {
		binary = atob(data);
	} catch {
		return invalidPrivateContext('data must be canonical padded Base64.');
	}
	if (btoa(binary) !== data) {
		return invalidPrivateContext('data must be canonical padded Base64.');
	}
	const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
	if (bytes.byteLength > MAX_PRIVATE_CONTEXT_BYTES) {
		return invalidPrivateContext(`decoded data exceeds the ${MAX_PRIVATE_CONTEXT_BYTES} byte limit.`);
	}
	return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return invalidPrivateContext('decoded data must be valid UTF-8.');
	}
}

export interface VerifiedOpaquePrivateContext {
	text: string;
	byteLength: number;
}

/** Verify one envelope and return its exact UTF-8 text for provider-only injection. */
export async function verifyOpaquePrivateContext(
	context: OpaquePrivateContext,
): Promise<VerifiedOpaquePrivateContext> {
	const bytes = decodeCanonicalBase64(context.data);
	const decoded = decodeUtf8(bytes);
	const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	if (digest !== context.sha256) {
		invalidPrivateContext('sha256 digest does not match decoded data.');
	}
	return { text: decoded, byteLength: bytes.byteLength };
}

/** Verify integrity before any direct or dispatched message is durably admitted. */
export async function verifyDeliveredPrivateContext(message: DeliveredMessage): Promise<void> {
	if (message.privateContext) await verifyOpaquePrivateContext(message.privateContext);
}
