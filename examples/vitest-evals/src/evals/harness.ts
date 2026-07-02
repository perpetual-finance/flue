// flue-blueprint: tooling/vitest-evals@1
import { createFlueClient, type FlueConversationMessage } from '@flue/sdk';
import { createHarness, type SimpleToolCallRecord } from 'vitest-evals';

export interface FlueAgentHarnessOptions {
	/**
	 * Absolute URL where the agent's routes are mounted (wherever the
	 * application's app.ts mounts `agent.route()`). Each eval case runs in a
	 * fresh conversation at `<agentUrl>/eval-<uuid>`.
	 */
	agentUrl: string;
	/** Harness display name; defaults to the agent URL's last path segment. */
	name?: string;
	token?: string;
	headers?: Record<string, string>;
}

function lastAssistantMessage(
	messages: FlueConversationMessage[],
): FlueConversationMessage | undefined {
	return messages.findLast((entry) => entry.role === 'assistant');
}

function messageText(message: FlueConversationMessage | undefined): string {
	if (!message) return '';
	return message.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('');
}

function collectToolCalls(messages: FlueConversationMessage[]): SimpleToolCallRecord[] {
	return messages.flatMap((message) =>
		message.parts.flatMap((part) => {
			if (part.type !== 'dynamic-tool') return [];
			return [
				{
					id: part.toolCallId,
					name: part.toolName,
					arguments: part.input,
					...(part.state === 'output-error'
						? { error: part.errorText }
						: part.state === 'output-available'
							? { result: part.output }
							: {}),
				},
			];
		}),
	);
}

export function createFlueAgentHarness(options: FlueAgentHarnessOptions) {
	const agentUrl = options.agentUrl.replace(/\/+$/, '');
	const agentName = options.name ?? (agentUrl.split('/').at(-1) as string);

	return createHarness<string, string>({
		name: `flue-${agentName}-agent`,
		run: async ({ input, signal }) => {
			// A fresh conversation per case: the caller constructs the URL by
			// appending a new id to the agent's mount URL.
			const conversation = createFlueClient({
				url: `${agentUrl}/eval-${crypto.randomUUID()}`,
				token: options.token,
				headers: options.headers,
			});
			const admission = await conversation.send({
				message: { kind: 'user', body: input },
				signal,
			});
			await conversation.wait(admission, { signal });
			const history = await conversation.history({ signal });
			const reply = lastAssistantMessage(history.messages);
			const usage = reply?.metadata?.usage;
			const model = reply?.metadata?.model;

			return {
				output: messageText(reply),
				toolCalls: collectToolCalls(history.messages),
				// The reply's own message metadata carries usage/model — the same
				// data the removed prompt-result surface used to return.
				...((usage ?? model)
					? {
							usage: {
								...(model ? { provider: model.provider, model: model.id } : {}),
								...(usage
									? {
											inputTokens: usage.input,
											outputTokens: usage.output,
											totalTokens: usage.totalTokens,
											metadata: { cost: usage.cost.total },
										}
									: {}),
							},
						}
					: {}),
			};
		},
	});
}
