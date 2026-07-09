import { describe, expect, it, vi } from 'vitest';
import { createReadTool, overlayPackagedSkills } from '../src/agent.ts';
import type { PackagedSkillDirectory } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const skill: PackagedSkillDirectory = {
	id: 'code-review',
	name: 'code-review',
	description: 'Reviews code changes.',
	files: {
		'SKILL.md': {
			encoding: 'base64',
			kind: 'text',
			content: Buffer.from('Inspect the patch carefully.').toString('base64'),
		},
		'references/checklist.md': {
			encoding: 'base64',
			kind: 'text',
			content: Buffer.from('Check errors.').toString('base64'),
		},
	},
};
const checklistPath = '/.flue/packaged-skills/code-review/references/checklist.md';

describe('overlayPackagedSkills()', () => {
	it('serves catalog paths from memory and delegates everything else', async () => {
		const readFile = vi.fn(async () => 'real file');
		const env = overlayPackagedSkills(createNoopSessionEnv({ readFile }), {
			'code-review': skill,
		});

		await expect(env.readFile(checklistPath)).resolves.toBe('Check errors.');
		await expect(env.readFile('/repo/real.txt')).resolves.toBe('real file');
		expect(readFile).toHaveBeenCalledExactlyOnceWith('/repo/real.txt');
	});

	it('reports unknown paths under the packaged root as missing without touching the env', async () => {
		const readFile = vi.fn(async () => 'real file');
		const env = overlayPackagedSkills(createNoopSessionEnv({ readFile }), {
			'code-review': skill,
		});

		await expect(env.readFile('/.flue/packaged-skills/code-review/missing.md')).rejects.toThrow(
			'Packaged skill file not found',
		);
		expect(readFile).not.toHaveBeenCalled();
	});

	it('routes packaged paths for any tool reading through the env', async () => {
		const env = overlayPackagedSkills(createNoopSessionEnv(), { 'code-review': skill });
		const read = createReadTool(env);

		const result = await read.execute('call', { path: checklistPath });

		expect(result.content).toEqual([{ type: 'text', text: 'Check errors.' }]);
	});

	it('leaves every other env member untouched', () => {
		const base = createNoopSessionEnv();
		const env = overlayPackagedSkills(base, { 'code-review': skill });

		expect(env.exec).toBe(base.exec);
		expect(env.writeFile).toBe(base.writeFile);
		expect(env.cwd).toBe(base.cwd);
		expect(env.resolvePath).toBe(base.resolvePath);
	});
});
