'use agent';
import { defineAgent, defineAgentProfile } from '@flue/runtime';

const sessionTest = defineAgentProfile({
	instructions: 'You are a test agent for session-oriented message delivery.',
});

export default defineAgent(() => ({ profile: sessionTest }));
