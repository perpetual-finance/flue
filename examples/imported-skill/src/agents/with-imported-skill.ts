'use agent';
import { defineAction, defineAgent } from '@flue/runtime';
import review from '../skills/review/SKILL.md' with { type: 'skill' };

const runReviewSkill = defineAction({
	name: 'run-review-skill',
	description: 'Run the imported `review` skill directly and return its answer.',
	async run({ harness }) {
		const session = await harness.session();
		const response = await session.skill(review);
		return { text: response.text, reference: review.name };
	},
});

export default defineAgent(() => ({
	model: 'anthropic/claude-haiku-4-5',
	// Registering the reference exposes the skill's packaged files to ordinary
	// prompts too, not just the direct `session.skill(review)` call above.
	skills: [review],
	instructions:
		'When asked to run the demo, call the `run-review-skill` action and report its result.',
	actions: [runReviewSkill],
}));
