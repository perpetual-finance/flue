---
title: flue init
description: Reference for creating an initial Flue project configuration file.
lastReviewedAt: 2026-07-02
---

## Synopsis

```bash
flue init --target <node|cloudflare> [--root <path>] [--force]
```

## Description

`flue init` writes a starter `flue.config.ts`. It does not create agents, an `app.ts` entrypoint, or a `vite.config.ts`.

## Options

| Option                        | Default                   | Description                                                        |
| ----------------------------- | ------------------------- | ------------------------------------------------------------------ |
| `--target <node\|cloudflare>` | Required                  | Select the target written to `flue.config.ts`.                     |
| `--root <path>`               | Current working directory | Select the existing directory in which to write `flue.config.ts`.  |
| `--force`                     | `false`                   | Write `flue.config.ts` when a `flue.config.*` file already exists. |

Without `--force`, any existing `flue.config.*` file prevents generation. If `--force` writes `flue.config.ts` beside another supported variant, the new `.ts` file takes precedence and the existing file remains on disk.

## Output

The generated `target` value matches `--target`. For `flue init --target node`, the file is:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
});
```

`defineConfig` is exported from `@flue/runtime/config` (it moved out of `@flue/cli`).

## Examples

```bash
flue init --target node
flue init --target cloudflare --root ./apps/assistant
```

See [Configuration](/docs/reference/configuration/) for the complete `flue.config.ts` surface.
