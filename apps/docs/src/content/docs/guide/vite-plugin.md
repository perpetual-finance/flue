---
title: Vite plugin
description: Build, develop, and deploy Flue applications with the flue() Vite plugin.
lastReviewedAt: 2026-07-11
---

Flue deploys as a [Vite](https://vite.dev/) plugin. Adding `flue()` from `@flue/vite` to `vite.config.ts` makes a Vite project a Flue application: `vite dev` serves it and `vite build` produces the deployable artifact. There are no framework-owned dev or build commands — Vite's are the only ones.

```ts title="vite.config.ts (Node)"
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
});
```

```ts title="vite.config.ts (Cloudflare)"
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue(), cloudflare()],
});
```

The plugin does three jobs on both targets:

1. **Resolves the project.** It discovers [`flue.config.ts`](/docs/reference/configuration/) and locates your entry modules (`app.ts` required; `db.ts` and `cloudflare.ts` optional).
2. **Scans for agents.** The [`'use agent'`](/docs/guide/use-agent/) scan over your source root defines the application's agent set — every exported capitalized function of a marked module — and the generated server bootstrap registers every scanned agent.
3. **Transforms agent modules.** The build stamps each agent's identity (the function name, or its `agentName` static override) as a string literal bound to the function, so a minified production bundle cannot corrupt the durable identity.

## Plugin options

`flue()` accepts the Flue config object itself — the same shape `flue.config.ts` exports. Inline values merge over the discovered config file, field by field, with inline winning:

```ts
function flue(config?: FlueConfig): Plugin[];

// e.g. pin the target regardless of the plugin array:
flue({ target: 'node' });
```

Most projects pass nothing and keep configuration in `flue.config.ts`, where `flue run` can also read it. See [Configuration](/docs/reference/configuration/) for every field.

## Target auto-detection

When `target` is unset, `flue()` inspects the resolved Vite plugin array: if `@cloudflare/vite-plugin` is present, the target is `'cloudflare'`; otherwise it is `'node'`. An explicit `target` (inline or in `flue.config.ts`) overrides detection — and setting `target: 'cloudflare'` without the sibling plugin installed is an error rather than a silent fallback.

## The Node target

### Development

`vite dev` loads `app.ts` through Vite's module graph and serves it on Vite's own server (default port `5173`). Everything Vite gives you applies: instant reload on edits, `--port`, environment handling. Flue additionally:

- watches for `'use agent'` changes — adding or removing a marked module, or adding and removing agent exports, updates the registered agent set without a manual restart;
- restarts the dev server when `flue.config.*` changes;
- loads your project's `.env` file set (`.env`, `.env.local`, `.env.<mode>`, `.env.<mode>.local`) into the application's environment, shell-exported values winning — model-provider keys work without a shell export;
- applies permissive dev CORS defaults (reflected origin with credentials, plus the durable-stream coordination headers) so a separately served SPA can talk to it. Deployed servers keep CORS as an application concern.

### Build and run

`vite build` bundles the application into two Node entries: the self-starting `dist/server.mjs`, and the non-listening `dist/app.mjs` application chunk it imports (for artifact-based consumers such as `vite preview` or a custom host):

```bash
vite build
node dist/server.mjs
```

The built server listens on port `3000` by default; set `PORT` to change it. It does not load `.env` — supply the environment when you start it. Application dependencies that cannot be bundled are externalized; deploy the artifact alongside its `node_modules` or a container that installs them.

### Preview

`vite preview` serves the built artifact: it imports `dist/app.mjs` natively — no Vite transformation — so what preview serves is exactly what `node dist/server.mjs` would serve, including production persistence defaults and the real process environment. Run `vite build` first; preview fails with that guidance when no artifact exists. One local-tooling difference from the raw artifact: preview defaults to the same permissive CORS policy as `vite dev` (override with Vite's `preview.cors`), so separate-origin local clients like the repo's demo chat app work against it; `node dist/server.mjs` has no CORS layer at all.

## The Cloudflare target

On Cloudflare, `flue()` cooperates with the official `@cloudflare/vite-plugin`, which owns workerd dev, build output, preview, and deploy. Flue's job is generating the Worker inputs the sibling plugin consumes:

- **`.flue-vite/_entry.ts`** — the generated Worker entry. It imports your `app.ts` (and `cloudflare.ts` when present), registers the scanned agent set, and exports one Durable Object class per agent (a `'use agent'` module with several agent exports produces several classes).
- **`.flue-vite.wrangler.jsonc`** — your authored `wrangler.jsonc` merged with Flue's contributions: `main` (the generated entry) and one Durable Object binding per agent. Everything else in your wrangler config passes through untouched. Your authored file is never modified.

Add both generated paths to `.gitignore`:

```gitignore
.flue-vite/
.flue-vite.wrangler.jsonc
```

**Ordering matters:** `flue()` must come before `cloudflare()` in the plugins array, because it prepares these inputs while Vite resolves the config, before the Cloudflare plugin reads them. The wrong order is diagnosed with an error.

### Migrations: the triple for adding an agent

Durable Object **migration history stays user-authored** in your `wrangler.jsonc`. Flue generates classes and bindings but never writes migrations, because migration history is an ordered, append-only record of your deployments. Adding an agent is therefore always a triple:

1. **the agent** — an exported `Triage` function in a `'use agent'` module;
2. **the mount** — `app.route('/agents/triage', createAgentRouter(Triage))` in `app.ts` (skip for dispatch-only agents);
3. **the migration tag** — a new entry in `wrangler.jsonc` for the generated class:

```jsonc title="wrangler.jsonc"
{
  "name": "my-flue-worker",
  "compatibility_date": "2026-06-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueTriageAgent"] }],
}
```

Class names derive from agent identities (`Triage` → `FlueTriageAgent`; an `agentName` static literal overrides the function name), so an identity change — renaming the function with no `agentName` pin, or editing the pin itself — is a storage-identity change expressed with wrangler-native `renamed_classes`, and removing an agent needs a `deleted_classes` entry. Renaming or moving the file changes nothing. See [Cloudflare](/docs/guide/targets/cloudflare/) for the full migration reference.

### Development

`vite dev` runs your Worker in workerd via the Cloudflare plugin, with the same permissive dev CORS defaults as the Node target (Vite's middleware stack applies them before workerd sees the request). Flue keeps the generated inputs fresh: agent-set changes (adding or removing a `'use agent'` file, or an agent export within one) and authored `wrangler.jsonc` edits regenerate the entry and merged config, and the Cloudflare plugin picks them up. Writes are content-aware — editing an agent's body regenerates nothing, so there are no restart loops. `vite preview` and deployment come from the Cloudflare plugin; see [Deploy on Cloudflare](/docs/ecosystem/deploy/cloudflare/).

## What the plugin does not do

- **One-shot local execution.** [`flue run <path> --message "..."`](/docs/cli/run/) runs an agent module directly under Node, without Vite's dev server or any HTTP listener. It reads `flue.config.ts` itself and never touches `vite.config.ts`.
- **Route generation.** The plugin registers agents; it mounts nothing. Your [`app.ts`](/docs/guide/routing/) is the route map.

## Next steps

- [Getting Started](/docs/getting-started/quickstart/) — a complete project from scratch.
- [Routing](/docs/guide/routing/) — mount agents and channels in `app.ts`.
- [`'use agent'`](/docs/guide/use-agent/) — the directive behind the scan.
- [Configuration](/docs/reference/configuration/) — every `flue.config.ts` field.
