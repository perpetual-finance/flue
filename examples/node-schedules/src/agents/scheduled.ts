'use agent';
import { defineAgent, defineAgentProfile } from '@flue/runtime';

const scheduledAgent = defineAgentProfile({
	model: 'anthropic/claude-sonnet-4-6',
	instructions: 'Complete scheduled tasks autonomously.',
});

export default defineAgent(() => ({ profile: scheduledAgent }));
