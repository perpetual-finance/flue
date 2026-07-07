'use agent';
import { defineAgent } from '@flue/runtime';

function Scheduled() {
	return 'Complete scheduled tasks autonomously.';
}

export default defineAgent(Scheduled, { model: 'anthropic/claude-sonnet-4-6' });
