import { useModel } from '../../src/hooks/use-model.ts';
import { sqlite } from '../../src/node/agent-execution-store.ts';
import type {
	AgentRecord,
	CloudflareRuntime,
	NodeRuntime,
} from '../../src/runtime/flue-app.ts';
import type { Agent } from '../../src/types.ts';

function defaultAgent(): Agent {
	return function DefaultTestAgent() {
		useModel('anthropic/claude-haiku-4-5');
	};
}

export function agentRecord(
	name: string,
	options: {
		agent?: Agent;
	} = {},
): AgentRecord {
	return {
		name,
		agent: options.agent ?? defaultAgent(),
	};
}

export function nodeRuntime(overrides: Partial<NodeRuntime> = {}): NodeRuntime {
	const adapter = sqlite();
	void adapter.migrate?.();
	const stores = adapter.connect();
	if (stores instanceof Promise) throw new Error('Test SQLite adapter must connect synchronously.');
	return {
		target: 'node',
		agents: [],
		dispatchQueue: {
			enqueue: async (input) => ({ dispatchId: input.dispatchId, acceptedAt: input.acceptedAt }),
		},
		createAgentAdmission: () => {
			throw new Error('Unexpected agent admission.');
		},
		abortAgentInstance: async () => false,
		conversationStreamStore: stores.conversationStreamStore,
		attachmentStore: stores.attachmentStore,
		...overrides,
	};
}

export function cloudflareRuntime(overrides: Partial<CloudflareRuntime> = {}): CloudflareRuntime {
	return {
		target: 'cloudflare',
		agents: [],
		dispatchQueue: {
			enqueue: async (input) => ({ dispatchId: input.dispatchId, acceptedAt: input.acceptedAt }),
		},
		routeAgentRequest: async () => null,
		instanceInfo: async () => null,
		...overrides,
	};
}
