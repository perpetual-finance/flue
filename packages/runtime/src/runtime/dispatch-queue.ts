import type { DeliveredMessage, DispatchReceipt } from '../types.ts';

export interface DispatchInput {
	dispatchId: string;
	agent: string;
	id: string;
	message: DeliveredMessage;
	/** Instance-creation data; consulted only on the instance's first contact. */
	data?: unknown;
	acceptedAt: string;
}

export interface DispatchQueue {
	enqueue(input: DispatchInput): Promise<DispatchReceipt>;
}
