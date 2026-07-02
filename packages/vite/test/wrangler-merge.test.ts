/**
 * Pure merge/validate semantics of the ported wrangler merge (the CLI keeps
 * its own copy + tests until Phase 6; these mirror them so the port can't
 * drift).
 */
import { describe, expect, it } from 'vitest';
import { mergeFlueAdditions, validateUserWranglerConfig } from '../src/wrangler-merge.ts';

const additions = {
	defaultName: 'fixture',
	main: '.flue-vite/_entry.ts',
	doBindings: [{ name: 'FLUE_ASSISTANT_AGENT', class_name: 'FlueAssistantAgent' }],
};

describe('mergeFlueAdditions()', () => {
	it('always writes main, defaults name, and unions nodejs_compat', () => {
		const merged = mergeFlueAdditions({ main: 'user-entry.ts' }, additions);

		expect(merged.main).toBe('.flue-vite/_entry.ts');
		expect(merged.name).toBe('fixture');
		expect(merged.compatibility_date).toBe('2026-04-01');
		expect(merged.compatibility_flags).toEqual(['nodejs_compat']);
		expect(merged.durable_objects).toEqual({
			bindings: [{ name: 'FLUE_ASSISTANT_AGENT', class_name: 'FlueAssistantAgent' }],
		});
	});

	it('lets user name, compatibility_date, and migrations pass through', () => {
		const migrations = [{ tag: 'v1', new_sqlite_classes: ['FlueAssistantAgent'] }];
		const merged = mergeFlueAdditions(
			{ name: 'authored', compatibility_date: '2026-06-01', migrations },
			additions,
		);

		expect(merged.name).toBe('authored');
		expect(merged.compatibility_date).toBe('2026-06-01');
		expect(merged.migrations).toEqual(migrations);
	});

	it('preserves a matching local Flue-generated Durable Object binding', () => {
		const binding = { name: 'FLUE_ASSISTANT_AGENT', class_name: 'FlueAssistantAgent' };
		const merged = mergeFlueAdditions({ durable_objects: { bindings: [binding] } }, additions) as {
			durable_objects: { bindings: unknown[] };
		};

		expect(merged.durable_objects.bindings).toEqual([binding]);
	});

	it('preserves user Durable Object bindings alongside Flue additions', () => {
		const sandbox = { name: 'Sandbox', class_name: 'Sandbox' };
		const merged = mergeFlueAdditions({ durable_objects: { bindings: [sandbox] } }, additions) as {
			durable_objects: { bindings: unknown[] };
		};

		expect(merged.durable_objects.bindings).toEqual([
			sandbox,
			{ name: 'FLUE_ASSISTANT_AGENT', class_name: 'FlueAssistantAgent' },
		]);
	});

	it('rejects an authored binding that shadows a Flue-generated binding', () => {
		expect(() =>
			mergeFlueAdditions(
				{
					durable_objects: {
						bindings: [{ name: 'FLUE_ASSISTANT_AGENT', class_name: 'Counter' }],
					},
				},
				additions,
			),
		).toThrow(
			'Expected a local class_name "FlueAssistantAgent" binding without script_name or environment.',
		);
	});

	it('rejects an externally redirected Flue-generated Durable Object binding', () => {
		expect(() =>
			mergeFlueAdditions(
				{
					durable_objects: {
						bindings: [
							{
								name: 'FLUE_ASSISTANT_AGENT',
								class_name: 'FlueAssistantAgent',
								script_name: 'other-worker',
							},
						],
					},
				},
				additions,
			),
		).toThrow(
			'Expected a local class_name "FlueAssistantAgent" binding without script_name or environment.',
		);
	});

	it('rejects an externally redirected Flue-generated Durable Object binding in an environment', () => {
		expect(() =>
			mergeFlueAdditions(
				{
					env: {
						staging: {
							durable_objects: {
								bindings: [
									{
										name: 'FLUE_ASSISTANT_AGENT',
										class_name: 'FlueAssistantAgent',
										script_name: 'other-worker',
										environment: 'production',
									},
								],
							},
						},
					},
				},
				additions,
			),
		).toThrow(
			'Expected a local class_name "FlueAssistantAgent" binding without script_name or environment.',
		);
	});

	it('unions nodejs_compat into a compatibility_flags override in an environment', () => {
		const merged = mergeFlueAdditions(
			{ env: { staging: { compatibility_flags: ['some_flag'] } } },
			additions,
		) as { env: { staging: { compatibility_flags: string[] } } };

		expect(merged.env.staging.compatibility_flags).toEqual(['some_flag', 'nodejs_compat']);
	});

	it('leaves compatibility_flags unset in an environment without its own override', () => {
		const merged = mergeFlueAdditions({ env: { staging: {} } }, additions) as {
			compatibility_flags: string[];
			env: { staging: Record<string, unknown> };
		};

		expect(merged.compatibility_flags).toEqual(['nodejs_compat']);
		expect(merged.env.staging.compatibility_flags).toBeUndefined();
	});

	it('writes main into every environment block', () => {
		const merged = mergeFlueAdditions({ env: { staging: { main: 'their-entry.ts' } } }, additions) as {
			env: { staging: { main: string } };
		};

		expect(merged.env.staging.main).toBe('.flue-vite/_entry.ts');
	});
});

describe('validateUserWranglerConfig()', () => {
	it('rejects a compatibility_flags override missing nodejs_compat in an environment', () => {
		expect(() =>
			validateUserWranglerConfig({
				config: { env: { staging: { compatibility_flags: ['some_flag'] } } },
				effectiveConfig: { compatibility_flags: ['nodejs_compat'] },
			}),
		).toThrow('"env.staging.compatibility_flags" is missing "nodejs_compat"');
	});

	it('rejects a compatibility_date override below the supported floor in an environment', () => {
		expect(() =>
			validateUserWranglerConfig({
				config: { env: { staging: { compatibility_date: '2025-01-01' } } },
				effectiveConfig: { compatibility_date: '2026-06-01' },
			}),
		).toThrow('"env.staging.compatibility_date" is "2025-01-01"');
	});

	it('rejects a malformed top-level compatibility_date', () => {
		expect(() =>
			validateUserWranglerConfig({
				config: {},
				effectiveConfig: { compatibility_date: 'someday' },
			}),
		).toThrow('is not in YYYY-MM-DD format');
	});

	it('accepts a config meeting the floor with nodejs_compat', () => {
		expect(() =>
			validateUserWranglerConfig({
				config: {},
				effectiveConfig: {
					compatibility_date: '2026-06-01',
					compatibility_flags: ['nodejs_compat'],
				},
			}),
		).not.toThrow();
	});
});
