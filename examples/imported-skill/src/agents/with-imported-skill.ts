'use agent';
import { defineAgent, useSkill, useTool } from '@flue/runtime';
import review from '../skills/review/SKILL.md' with { type: 'skill' };

function WithImportedSkill() {
	// Registering the reference exposes the skill's packaged files to ordinary
	// prompts too, not just the direct `harness.skill(review)` call below.
	useSkill(review);
	useTool({
		name: 'run-review-skill',
		description: 'Run the imported `review` skill directly and return its answer.',
		harness: true,
		async run({ harness }) {
			const response = await harness.skill(review);
			return { text: response.text, reference: review.name };
		},
	});
	return 'When asked to run the demo, call the `run-review-skill` action and report its result.';
}

export default defineAgent(WithImportedSkill, { model: 'anthropic/claude-haiku-4-5' });
