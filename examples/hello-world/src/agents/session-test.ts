'use agent';
import { defineAgent } from '@flue/runtime';

function SessionTest() {
	return 'You are a test agent for session-oriented message delivery.';
}

// The legacy profile declared no model of its own; picking a low-cost default
// here since the function-agent config requires one.
export default defineAgent(SessionTest, { model: 'anthropic/claude-haiku-4-5' });
