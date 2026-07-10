'use agent';
import { defineAgent, useModel } from '@flue/runtime';

function Scheduled() {
	useModel('anthropic/claude-sonnet-4-6');
	return 'Complete scheduled tasks autonomously.';
}

export default defineAgent(Scheduled);
