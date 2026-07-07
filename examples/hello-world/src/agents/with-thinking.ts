'use agent';
import { defineAgent, useSubagent, useTool } from '@flue/runtime';
import * as v from 'valibot';

/** No instructions of its own — only the high `thinkingLevel` override matters here. */
function Auditor() {}

function WithThinking() {
	useSubagent({
		name: 'auditor',
		description: 'Reviews a claim carefully at a high reasoning effort.',
		capabilities: Auditor,
		thinkingLevel: 'high',
	});
	useTool({
		name: 'thinking-test',
		description: 'Compare thinking levels across the parent session and a high-thinking subagent.',
		harness: true,
		async run({ harness }) {
			const session = await harness.session();
			const Answer = v.object({ answer: v.string() });
			const fast = await session.prompt('In one word: capital of France?', { result: Answer });
			const careful = await session.task('Is 1009 prime? Justify briefly.', {
				agent: 'auditor',
				result: Answer,
			});
			const minimal = await session.task('Echo back: hello', {
				agent: 'auditor',
				thinkingLevel: 'minimal',
				result: Answer,
			});
			return { fast: fast.data, careful: careful.data, minimal: minimal.data };
		},
	});
	return 'When asked to run a demo, call the `thinking-test` tool and report its result.';
}

export default defineAgent(WithThinking, { model: 'anthropic/claude-haiku-4-5', thinkingLevel: 'low' });
