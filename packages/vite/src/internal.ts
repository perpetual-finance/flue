/**
 * `@flue/vite/internal` — building blocks shared with other Flue tooling.
 *
 * The only intended consumer is `@flue/cli` (`flue run` composes its
 * non-listening module server from these pieces). Everything here is
 * internal plumbing: no semver guarantees, subject to change between
 * releases.
 */
export type { DependencyResolverState } from './dependency-resolver.ts';
export { flueDependencyResolverPlugin } from './dependency-resolver.ts';
export { importAttributePlugin } from './import-attribute-plugin.ts';
export type { ImportTrace } from './import-trace.ts';
export { createImportTrace, findCloudflareSpecifier } from './import-trace.ts';
