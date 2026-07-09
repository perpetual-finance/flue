import { describe, expect, it } from 'vitest';
import { createEditTool, createReadTool } from '../src/agent.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

describe('standard file tools', () => {
	it('rejects an edit when oldText is empty', async () => {
		const env = createNoopSessionEnv({ readFile: async () => 'file content' });
		const edit = createEditTool(env);

		await expect(
			edit.execute('call', { path: 'a.txt', oldText: '', newText: 'inserted' }),
		).rejects.toThrow('oldText must be a non-empty string');
	});

	it('returns the filesystem error when reading a directory', async () => {
		const env = createNoopSessionEnv({
			readFile: async () => {
				throw new Error('EISDIR: illegal operation on a directory, read');
			},
			stat: async () => {
				throw new Error('stat should not be called');
			},
		});
		const read = createReadTool(env);

		await expect(read.execute('call', { path: 'directory' })).rejects.toThrow(
			'EISDIR: illegal operation on a directory, read',
		);
	});
});
