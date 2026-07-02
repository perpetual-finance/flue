import { describe, expect, it } from 'vitest';
import { installDevLifecycleLogger } from '../src/internal.ts';

describe('installDevLifecycleLogger()', () => {
	it('logs agent interaction starts without prompt content', () => {
		const messages: string[] = [];
		const logger = installDevLifecycleLogger((message) => messages.push(message));

		try {
			logger.onAgentInteractionStart({
				agentName: 'support',
				instanceId: 'customer-1',
				kind: 'direct',
				submissionId: 'submission-1',
			});

			expect(messages).toEqual(['[agent] support@customer-1 started']);
		} finally {
			logger.dispose();
		}
	});
});
