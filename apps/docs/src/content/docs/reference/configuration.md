---
title: Configuration
description: Reference for flue.config.ts options.
lastReviewedAt: 2026-07-02
---

`flue.config.ts` is the host-independent description of a Flue project: which target it builds for, where its entry modules live, and which files the `'use agent'` scan covers. Import `defineConfig()` from `@flue/runtime/config` for type checking and editor completion:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
});
```

Two consumers read it:

- the [`flue()` Vite plugin](/docs/guide/vite-plugin/) auto-discovers it, merging any inline `flue(config)` values over the file (inline wins, field by field);
- [`flue run`](/docs/cli/run/) reads it directly — it never touches `vite.config.ts`.

Only the options listed below are accepted; unknown fields are an error. Flue recognizes `flue.config.ts`, `.mts`, `.mjs`, `.js`, `.cjs`, and `.cts`, in that priority order, at the project root. TypeScript configuration files are loaded through Node's type-stripping and must use erasable syntax (no `enum`, runtime `namespace`, parameter properties, or decorators).

The file is optional. A project with no `flue.config.ts` uses the defaults below — for a Node project whose entries follow the standard lookup, the empty config is complete.

## `target`

- **Type:** `'node' | 'cloudflare'`
- **Default:** auto-detected

Build and development target.

- `'node'` builds a Node.js server.
- `'cloudflare'` builds a Workers-compatible application.

When unset, the Vite plugin detects `'cloudflare'` from the presence of `@cloudflare/vite-plugin` in the Vite plugin array, and `'node'` otherwise. `flue run` is always Node-local regardless of target.

## `app`

- **Type:** `string`
- **Default:** source-root lookup (see below)

Path to the application entry ([`app.ts`](/docs/guide/routing/)), the project's route map. Relative values resolve from the config file's directory. An explicit path must exist — a missing file is an error, not a fallback. The app entry is required by the Vite plugin: without one (configured or discovered), the build fails with a starter suggestion.

## `db`

- **Type:** `string`
- **Default:** source-root lookup

Path to the persistence entry ([`db.ts`](/docs/guide/database/)). Node hosts only; the Cloudflare target uses Durable Object SQLite instead. Same resolution rules as `app`.

## `cloudflare`

- **Type:** `string`
- **Default:** source-root lookup

Path to the non-HTTP Cloudflare handlers entry ([`cloudflare.ts`](/docs/guide/targets/cloudflare/#extending-cloudflarets-entrypoint)). Same resolution rules as `app`.

## `agents`

- **Type:** `string`
- **Default:** the whole source root, recursively

Glob narrowing the [`'use agent'` scan](/docs/guide/use-agent/), relative to the source root (for example `'agents/**/*.ts'`). Matches are still restricted to `.ts`/`.mts`/`.js`/`.mjs` modules and the standard exclusions (`node_modules`, build output, generated directories).

## Source-root lookup

Unset entry paths (`app`, `db`, `cloudflare`) are discovered from the project's **source root**, selected in this order:

1. `<root>/.flue` when it exists as a directory
2. `<root>/src` when it exists as a directory
3. `<root>` itself

Within the source root, each entry basename is tried with the extension priority `ts > mts > js > mjs` (`app.ts`, then `app.mts`, …). The `'use agent'` scan runs over the same source root. See [Project Layout](/docs/guide/project-layout/).

## `defineConfig()`

```ts
import { defineConfig, type FlueConfig } from '@flue/runtime/config';

function defineConfig(config: FlueConfig): FlueConfig;
```

Provides type checking and editor completion for `flue.config.ts`. Returns the configuration unchanged.

`@flue/runtime/config` is host-side tooling (it touches the filesystem when loading configs); import it from configuration and build code, never from agent modules.
