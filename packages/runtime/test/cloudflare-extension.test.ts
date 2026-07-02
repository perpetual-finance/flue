import type { DurableObject } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	type CloudflareAgentLike,
	type ExtensionClass,
	extend,
	resolveCloudflareExtension,
} from '../src/cloudflare/extension.ts';

class Agent {}

// Type-level regression for #410: `wrap` and `base` receive the concrete
// branded generated Durable Object constructor, so brand-checked platform
// instrumentation accepts it with no casts or runtime narrowing. The
// signatures below mirror `@sentry/cloudflare`'s
// `instrumentDurableObjectWithSentry` verbatim.
interface ConsumerEnv {
	readonly SENTRY_DSN: string;
}

interface ConsumerOptions {
	readonly dsn: string;
}

declare function instrumentDurableObjectWithSentry<
	E,
	T extends DurableObject<E>,
	C extends new (state: DurableObjectState, env: E) => T,
>(optionsCallback: (env: E) => ConsumerOptions, DurableObjectClass: C): C;

// Consumer base types stay structural; they never have to extend
// `DurableObject<Env>` themselves (its `ctx` is protected, which conflicts
// with bases that model a narrower public `ctx`).
interface ConsumerBase extends CloudflareAgentLike {
	ctx: { storage: { get(key: string): Promise<unknown> } };
}

extend<ConsumerBase, ConsumerEnv>({
	wrap: (Final) =>
		instrumentDurableObjectWithSentry((env: ConsumerEnv) => ({ dsn: env.SENTRY_DSN }), Final),
});

// The default-typed surface accepts the same pass-through.
extend({
	wrap: (Final) =>
		instrumentDurableObjectWithSentry((env: ConsumerEnv) => ({ dsn: env.SENTRY_DSN }), Final),
});

// `base` subclassing keeps working against the branded constructor.
extend<ConsumerBase, ConsumerEnv>({
	base: (Base) => class extends Base {},
});

describe('resolveCloudflareExtension()', () => {
	it('defaults omitted extension callbacks to identity operations for agents', () => {
		const extension = resolveCloudflareExtension({ cloudflare: extend({}) }, 'assistant', 'Agent');

		expect(extension.base(Agent)).toBe(Agent);
		expect(extension.wrap(Agent)).toBe(Agent);
	});

	it('returns identity when no cloudflare export is present for agents', () => {
		const extension = resolveCloudflareExtension({}, 'assistant', 'Agent');

		expect(extension.base(Agent)).toBe(Agent);
		expect(extension.wrap(Agent)).toBe(Agent);
	});

	it('accepts constructor proxies returned by wrap callbacks for agents', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ wrap: (Final) => new Proxy(Final, {}) }) },
			'assistant',
			'Agent',
		);

		expect(extension.wrap(Agent)).not.toBe(Agent);
	});

	it('rejects malformed agent cloudflare exports', () => {
		expect(() => resolveCloudflareExtension({ cloudflare: {} }, 'assistant', 'Agent')).toThrow(
			'cloudflare export must be created with extend({ base, wrap })',
		);
	});

	it('rejects malformed base callbacks for agents', () => {
		expect(() =>
			resolveCloudflareExtension(
				{ cloudflare: extend({ base: true as never }) },
				'assistant',
				'Agent',
			),
		).toThrow('cloudflare.base must be a function');
	});

	it('rejects malformed wrap callbacks for agents', () => {
		expect(() =>
			resolveCloudflareExtension(
				{ cloudflare: extend({ wrap: true as never }) },
				'assistant',
				'Agent',
			),
		).toThrow('cloudflare.wrap must be a function');
	});

	it('rejects base callbacks that return unrelated classes for agents', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ base: () => class {} }) },
			'assistant',
			'Agent',
		);

		expect(() => extension.base(Agent)).toThrow(
			'cloudflare.base must return the received class or a subclass',
		);
	});

	it('rejects wrap callbacks that return unrelated classes for agents', () => {
		const extension = resolveCloudflareExtension(
			{ cloudflare: extend({ wrap: (() => class {}) as never }) },
			'assistant',
			'Agent',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects wrap callbacks that return subclasses for agents', () => {
		const extension = resolveCloudflareExtension(
			{
				cloudflare: extend({
					wrap: ((Final: ExtensionClass) => class extends Final {}) as never,
				}),
			},
			'assistant',
			'Agent',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects non-constructable prototype-preserving wrappers for agents', () => {
		const extension = resolveCloudflareExtension(
			{
				cloudflare: extend({
					wrap: (Final) => {
						const wrapper = () => Final;
						wrapper.prototype = Final.prototype;
						return wrapper as never;
					},
				}),
			},
			'assistant',
			'Agent',
		);

		expect(() => extension.wrap(Agent)).toThrow(
			'cloudflare.wrap(Final) must return the received class or a constructor proxy',
		);
	});

	it('rejects malformed extend descriptors', () => {
		expect(() => extend(null as never)).toThrow('extend() expects an object');
		expect(() => extend(undefined as never)).toThrow('extend() expects an object');
		expect(() => extend([] as never)).toThrow('extend() expects an object');
	});

	it('rejects unknown extend descriptor options', () => {
		expect(() => extend({ warp: (Final: ExtensionClass) => Final } as never)).toThrow(
			'extend() received unknown option(s): warp',
		);
	});

});
