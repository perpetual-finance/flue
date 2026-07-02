---
title: CLI
description: Use the Flue CLI to configure a project, exercise agents locally, and fetch blueprints and documentation.
lastReviewedAt: 2026-07-02
---

Install `@flue/cli` as a development dependency, then invoke `flue` through your package manager:

```bash
npm install --save-dev @flue/cli
npx flue run src/agents/assistant.ts --message "Summarize this repository."
```

The CLI requires Node.js `>=22.19.0`.

## Dev servers and builds belong to Vite

The CLI does not serve or build your application. Development and production builds are owned by Vite through the `flue()` plugin from `@flue/vite`:

```ts title="vite.config.ts"
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
});
```

```bash
vite dev     # local development server
vite build   # deployable artifacts
```

`flue dev` and `flue build` were removed, not wrapped — running them prints a pointer to the Vite command. See the [Node.js](/docs/ecosystem/deploy/node/) and [Cloudflare](/docs/ecosystem/deploy/cloudflare/) deployment guides for the target-specific build story.

## Exercise one agent

`flue run` executes one agent module locally — transport-free, no HTTP listener — streams its activity, prints the reply, and exits:

```bash
npx flue run src/agents/assistant.ts --message "Draft a release summary."
```

Pass `--id` to continue the same conversation across invocations. See [`flue run`](/docs/cli/run/).

## Command reference

| Command                            | Description                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| [`flue run`](/docs/cli/run/)       | Run one agent module locally (transport-free), print its reply, then exit.      |
| [`flue init`](/docs/cli/init/)     | Create an initial `flue.config.ts`.                                             |
| [`flue add`](/docs/cli/add/)       | Fetch sandbox, channel, database, or tooling blueprints for a coding agent.     |
| [`flue update`](/docs/cli/update/) | Fetch a current blueprint so a coding agent can apply its newer upgrade guides. |
| [`flue docs`](/docs/cli/docs/)     | List, read, and search the bundled Flue documentation.                          |

## Removed commands

| Removed           | Replacement                                                             |
| ----------------- | ----------------------------------------------------------------------- |
| `flue dev`        | `vite dev` with the `flue()` plugin in `vite.config.ts`.                |
| `flue build`      | `vite build` with the `flue()` plugin in `vite.config.ts`.              |
| `flue run <name>` | `flue run <path>` — the command takes an agent module path, not a name. |

Removed commands and dropped flags fail with an explicit pointer at their replacement rather than a generic usage error.
