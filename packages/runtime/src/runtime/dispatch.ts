import type { DeliveredMessage, DispatchReceipt, NamedAgentDispatchRequest } from '../types.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import { generateDispatchId } from './ids.ts';
import { parseDeliveredMessage } from './schemas.ts';

export interface DispatchRuntime {
	agents: ReadonlyArray<{ name: string }>;
}

export async function enqueueDispatch(options: {
	request: NamedAgentDispatchRequest;
	dispatchQueue: DispatchQueue;
	rt: DispatchRuntime;
}): Promise<DispatchReceipt> {
	const agent = options.request.agent;
	const message = validateDispatchRequest(options.request, agent, options.rt);
	if (typeof options.request.uid === 'string' && options.request.initialData !== undefined) {
		throw new Error(
			'[flue] dispatch() cannot combine a continue condition (`uid`) with `initialData` — the condition forbids creation, so the seed could never apply.',
		);
	}
	return options.dispatchQueue.enqueue({
		dispatchId: generateDispatchId(),
		agent,
		id: options.request.id,
		message,
		...(options.request.initialData !== undefined ? { initialData: options.request.initialData } : {}),
		...(options.request.uid !== undefined ? { uid: options.request.uid } : {}),
		acceptedAt: new Date().toISOString(),
	});
}

function validateDispatchRequest(
	request: NamedAgentDispatchRequest,
	agent: string,
	rt: DispatchRuntime,
): DeliveredMessage {
	if (typeof agent !== 'string' || agent.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty target agent.');
	}
	if (typeof request.id !== 'string' || request.id.trim() === '') {
		throw new Error('[flue] dispatch() requires a non-empty "id" target agent instance id.');
	}
	if (!agentExists(rt, agent)) {
		throw new Error(`[flue] dispatch() target agent "${agent}" is not registered.`);
	}
	return parseDeliveredMessage(request.message);
}

function agentExists(rt: DispatchRuntime, agentName: string): boolean {
	return rt.agents.some((agent) => agent.name === agentName);
}
