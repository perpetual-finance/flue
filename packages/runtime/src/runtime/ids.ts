import { ulid } from 'ulidx';

export function generateSessionAffinityKey(): string {
	return `aff_${ulid()}`;
}

export function generateConversationId(): string {
	return `conv_${ulid()}`;
}

export function generateOperationId(): string {
	return `op_${ulid()}`;
}

export function generateTurnId(): string {
	return `turn_${ulid()}`;
}

/**
 * The instance uid minted once at birth — names the incarnation (the
 * instance id is the reusable address; the uid distinguishes historical
 * occupants of the same id). Returned on send receipts and usable as a
 * send condition.
 */
export function generateInstanceUid(): string {
	return `inst_${ulid()}`;
}
