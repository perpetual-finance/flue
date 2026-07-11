---
title: flue init
description: Reference for scaffolding a starter Flue project skeleton.
lastReviewedAt: 2026-07-02
---

## Synopsis

```bash
flue init --target <node|cloudflare> [--root <path>] [--force]
```

## Description

`flue init` writes the minimal project skeleton for the selected target:

- **`flue.config.ts`** — the host-independent Flue project config, with `target` set from `--target`.
- **`vite.config.ts`** — a Vite config with the `flue()` plugin (plus `cloudflare()` on the Cloudflare target).
- **`src/app.ts`** — a starter [Hono](https://hono.dev/) route map with a commented example agent mount. This is the only file a Flue application requires.
- **`wrangler.jsonc`** (Cloudflare target only) — a starter Worker config with `nodejs_compat` and commented Durable Object migration guidance.

It does not create agents or install dependencies — see the [Getting Started guide](/docs/getting-started/quickstart/) for the full setup, including the packages to install.

## Options

| Option                        | Default                   | Description                                                         |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------- |
| `--target <node\|cloudflare>` | Required                  | Select the target written to `flue.config.ts` and `vite.config.ts`. |
| `--root <path>`               | Current working directory | Select the existing directory in which to scaffold.                 |
| `--force`                     | `false`                   | Write `flue.config.ts` when a `flue.config.*` file already exists.  |

Without `--force`, any existing `flue.config.*` file prevents generation. If `--force` writes `flue.config.ts` beside another supported variant, the new `.ts` file takes precedence and the existing file remains on disk.

`--force` applies only to `flue.config.*`. The other scaffolded files (`vite.config.ts`, `src/app.ts`, `wrangler.jsonc`) are created only when absent — `flue init` never overwrites them, and reports each kept file.

## Output

For `flue init --target node`, the generated files are:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
});
```

```ts title="vite.config.ts"
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
});
```

```ts title="src/app.ts"
import { Hono } from 'hono';

const app = new Hono();

// Mount every route explicitly. An agent module starts with the
// 'use agent' directive; create one and mount it here:
//
//   import { createAgentRouter } from '@flue/runtime/routing';
//   import { Assistant } from './agents/assistant.ts';
//   app.route('/agents/assistant', createAgentRouter(Assistant));

export default app;
```

With `--target cloudflare`, `vite.config.ts` adds `cloudflare()` from `@cloudflare/vite-plugin` after `flue()`, and a starter `wrangler.jsonc` is written with `nodejs_compat` enabled and a commented example of the Durable Object migration each `'use agent'` file requires. See [Cloudflare](/docs/guide/targets/cloudflare/) for the migration reference.

## Examples

```bash
flue init --target node
flue init --target cloudflare --root ./apps/assistant
```

See [Configuration](/docs/reference/configuration/) for the complete `flue.config.ts` surface.
