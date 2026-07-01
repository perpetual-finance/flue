import type { DeliveredMessage, DispatchReceipt } from '../types.ts';

export interface DispatchInput {
	dispatchId: string;
	agent: string;
	id: string;
	message: DeliveredMessage;
	acceptedAt: string;
}

export interface DispatchQueue {
	enqueue(input: DispatchInput): Promise<DispatchReceipt>;
}
