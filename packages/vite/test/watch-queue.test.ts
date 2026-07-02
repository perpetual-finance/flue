import { describe, expect, it } from 'vitest';
import { createWatchQueue } from '../src/watch-queue.ts';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

describe('createWatchQueue', () => {
	it('coalesces a synchronous burst into a single run', async () => {
		const queue = createWatchQueue();
		let runs = 0;
		const run = async () => {
			runs += 1;
		};

		// All six arrive before the queued run starts; they collapse into it.
		for (let i = 0; i < 6; i += 1) void queue.schedule(run);
		await queue.settled();

		expect(runs).toBe(1);
	});

	it('coalesces runs scheduled while one is in flight into a single follow-up', async () => {
		const queue = createWatchQueue();
		const gate = deferred();
		const started = deferred();
		let runs = 0;
		const run = async () => {
			runs += 1;
			started.resolve();
			await gate.promise;
		};

		void queue.schedule(run);
		await started.promise;
		// Five events during the in-flight run: the first queues a follow-up,
		// the other four coalesce into it.
		for (let i = 0; i < 5; i += 1) void queue.schedule(run);
		gate.resolve();
		await queue.settled();

		expect(runs).toBe(2);
	});

	it('queues a follow-up for events arriving mid-run (never drops them)', async () => {
		const queue = createWatchQueue();
		const firstRunStarted = deferred();
		const gate = deferred();
		const order: string[] = [];

		void queue.schedule(async () => {
			order.push('first');
			firstRunStarted.resolve();
			await gate.promise;
		});
		// The first run has started (its disk read may predate this event), so
		// this must NOT coalesce away.
		await firstRunStarted.promise;
		void queue.schedule(async () => {
			order.push('second');
		});
		gate.resolve();
		await queue.settled();

		expect(order).toEqual(['first', 'second']);
	});

	it('never overlaps runs', async () => {
		const queue = createWatchQueue();
		let active = 0;
		let maxActive = 0;
		const run = async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await new Promise((resolve) => setTimeout(resolve, 5));
			active -= 1;
		};
		await Promise.all([queue.schedule(run), queue.schedule(run), queue.schedule(run)]);
		await queue.settled();
		expect(maxActive).toBe(1);
	});

	it('keeps scheduling after a run rejects, and settled() never rejects', async () => {
		const queue = createWatchQueue();
		let secondRan = false;
		const failed = queue.schedule(async () => {
			throw new Error('boom');
		});
		await expect(failed).rejects.toThrow('boom');
		await queue.schedule(async () => {
			secondRan = true;
		});
		await queue.settled();
		expect(secondRan).toBe(true);
	});
});
