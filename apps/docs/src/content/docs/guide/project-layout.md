---
title: Project Layout
description: Understand the source files and generated output in a Flue project.
lastReviewedAt: 2026-07-02
---

A Flue project is a Vite project. Two config files at the root wire it up, `src/app.ts` is the application's route map (and the only required source file), and agents are ordinary modules marked with the [`'use agent'` directive](/docs/guide/use-agent/) anywhere under the source directory.

## Example project layout

```text
my-project/
├─ package.json
├─ vite.config.ts
├─ flue.config.ts
├─ wrangler.jsonc        # Cloudflare target only
├─ src/
│  ├─ app.ts             # required — the route map
│  ├─ db.ts              # optional — Node persistence
│  ├─ cloudflare.ts      # optional — non-HTTP Worker handlers
│  ├─ agents/
│  │  └─ support-assistant.ts   # 'use agent'
│  └─ channels/
│     └─ github.ts
└─ dist/
```

Organize supporting application code however you prefer inside `src/`. Only `app.ts`, `db.ts`, and `cloudflare.ts` are discovered by their names; everything else — including where agent and channel modules live — is your own structure. `agents/` and `channels/` are conventions this documentation follows, not rules.

## Important files

| Path             | Purpose                                                                                | Learn more                                                                      |
| ---------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `vite.config.ts` | Makes the project a Flue application via the `flue()` plugin; `vite dev`/`vite build`. | [Vite plugin](/docs/guide/vite-plugin/)                                         |
| `flue.config.ts` | Optional host-independent project config (target, entry paths, agent-scan glob).       | [Configuration](/docs/reference/configuration/)                                 |
| `app.ts`         | **Required.** The route map: mounts agents, channels, and custom routes.               | [Routing](/docs/guide/routing/)                                                 |
| `db.ts`          | Optional Node.js persistence adapter for durable conversations.                        | [Database](/docs/guide/database/)                                               |
| `cloudflare.ts`  | Optional Cloudflare-only module for Worker exports and non-HTTP handlers.              | [Cloudflare](/docs/guide/targets/cloudflare/#extending-cloudflarets-entrypoint) |
| Agent modules    | Files with the `'use agent'` directive, anywhere under the source directory.           | ['use agent'](/docs/guide/use-agent/)                                           |
| Channel modules  | Files exporting a `channel` binding, mounted in `app.ts`.                              | [Channels](/docs/guide/channels/)                                               |

### `app.ts`

`app.ts` default-exports an ordinary Hono application and is the single source of truth for your application's URLs — every agent and channel route is mounted there explicitly (`app.route('/agents/triage', triage.route())`). A project without an `app.ts` fails the build with a two-line starter suggestion. Because it imports `Hono`, include `hono` in your application dependencies.

For more information, see [Routing](/docs/guide/routing/).

### `db.ts`

`db.ts` is an optional Node.js persistence entrypoint. Its default export configures the `PersistenceAdapter` used for canonical agent conversations, attachments, and accepted submissions. Without it, Node.js uses in-memory SQLite and loses this state when the process exits. Cloudflare provides Durable Object SQLite automatically and does not use `db.ts`.

For more information, see [Database](/docs/guide/database/).

### `cloudflare.ts`

`cloudflare.ts` is an optional Cloudflare-only deployment module. Its named exports become top-level Worker exports, and its optional default export adds non-HTTP Worker handlers. Use it for same-Worker Durable Object classes, explicit Cloudflare Sandbox aliases, queue consumers, scheduled handlers, and other Cloudflare-native additions. Custom HTTP handling remains in `app.ts`.

For more information, see [Cloudflare](/docs/guide/targets/cloudflare/#extending-cloudflarets-entrypoint).

### Agent modules

An agent is any module under the source directory whose first statement is the `'use agent'` directive and whose default export is `defineAgent(...)`. The file basename is the agent's durable identity, so basenames must be unique among an application's agents and use lower-kebab-case (`support-assistant.ts`). Nesting is fine — `src/agents/` is just a tidy convention.

The build scans the source directory for marked modules and registers all of them; mounting in `app.ts` is a separate, explicit step (and optional for dispatch-only agents). To narrow the scan, set the `agents` glob in `flue.config.ts`.

For more information, see ['use agent'](/docs/guide/use-agent/).

### Channel modules

A channel module exports one named `channel` binding created by a provider package (`createSlackChannel(...)`, …). Mount it wherever you like: `app.route('/channels/slack', channel.route())`. The provider defines route suffixes such as `/events` or `/webhook` beneath your chosen mount.

For more information, see [Channels](/docs/guide/channels/).

## Source directory

`src/` is the canonical source directory for new Flue projects. When integrating Flue into another application or maintaining an existing layout, authored modules may instead live in `.flue/` or at the project root. Flue selects one source directory in this order:

1. `.flue/` — A self-contained Flue source area inside a larger application.
2. `src/` **(Recommended)** — The recommended layout for new projects.
3. The project root — A compact layout for small dedicated projects.

The first matching directory wins. Flue does not merge layouts: when `.flue/` exists, `app.ts`, `db.ts`, `cloudflare.ts`, and the `'use agent'` scan are resolved from it, not from `src/` or the project root. Authored modules may still import ordinary supporting code from elsewhere in the project.

Entry paths can also be set explicitly in `flue.config.ts` (`app`, `db`, `cloudflare`); see [Configuration](/docs/reference/configuration/).

## Generated output

- `dist/` — Vite's build output: `dist/server.mjs` on the Node target, the Worker output on Cloudflare. Configure it with Vite's own `build.outDir` if needed.
- `.flue-vite/` and `.flue-vite.wrangler.jsonc` — Cloudflare-target inputs generated by the plugin (the Worker entry and the merged wrangler config). Add them to `.gitignore`; your authored `wrangler.jsonc` is never modified.

Generated output is never part of authored source discovery or the agent scan.
