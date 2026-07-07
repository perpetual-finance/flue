'use agent';
import { defineAgent, useTool } from '@flue/runtime';
import * as v from 'valibot';

const TEST_PNG_BASE64 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function WithImage() {
	useTool({
		name: 'image-test',
		description: 'Send an image to a child session in plain and structured prompts.',
		harness: true,
		async run({ harness }) {
			const session = await harness.session();
			const image = { type: 'image' as const, data: TEST_PNG_BASE64, mimeType: 'image/png' };
			const plain = await session.prompt('What color is this image?', { images: [image] });
			const structured = await session.prompt('What color is this image?', {
				images: [image],
				result: v.object({ sawImage: v.boolean(), color: v.string() }),
			});
			return { plain: plain.text, structured: structured.data };
		},
	});
	return 'When asked to run a demo, call the `image-test` tool and report its result.';
}

export default defineAgent(WithImage, { model: 'anthropic/claude-sonnet-4-6' });
