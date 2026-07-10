---
title: flue run
description: Reference for running one agent module locally from the command line, without a server.
lastReviewedAt: 2026-07-07
---

## Synopsis

```bash
flue run <path> --message <text> [--id <conversation-id>] [--initial-data <json>] [--uid <uid> | --new] [--env <path>] [--json]
```

## Description

`flue run` executes one agent module locally under Node.js, delivers one `kind: 'user'` message into a conversation, streams the agent's activity to stderr, prints the final assistant reply to stdout, and exits. Execution is transport-free: the command compiles the module from disk itself, binds no port, and never starts an HTTP listener. It does not load `app.ts`, channels, or any HTTP composition — only the agent module (and whatever it imports).

`<path>` is the path of an agent module whose default export is `defineAgent(...)`, resolved from the current working directory. The agent's identity is the module's `export const name` when declared, else the file basename (`src/agents/triage.ts` runs as `triage`) — the same identity a `'use agent'` build would assign, so `flue run` shares conversation storage keys with the deployed application when both use the same database. The module does not need the `'use agent'` directive to be runnable here.

The run drives the same durable submission path as a deployed server: the message is durably admitted, processed, and settled, so `--id` continuations and recovery semantics match production behavior.

`flue run` is always Node-local. A module that imports `cloudflare:*` (directly or transitively) fails with a pointer at `vite dev`, where platform bindings exist.

## Options

| Option             | Default                        | Description                                                                       |
| ------------------ | ------------------------------ | --------------------------------------------------------------------------------- |
| `--message <text>` | Required                       | The user message submitted to the agent.                                          |
| `--id <id>`        | A fresh ULID, printed          | Conversation id to create or continue. Reuse an id to continue that conversation. |
| `--initial-data <json>` | —                               | Instance-creation data (JSON). The seed, used only when this run creates the conversation; read it with `useInitialData()`. Rejected together with `--uid` (the condition forbids creation, so the seed could never apply). |
| `--uid <uid>`      | —                               | Continue only the conversation incarnation with this uid (printed by the creating run, in the meta rows and the `--json` envelope). Rejects when that incarnation no longer exists. Rejected together with `--new` or `--initial-data`. |
| `--new`            | `false`                        | Create only: rejects when the conversation id already exists (the error names its uid). Rejected together with `--uid`.                                                                                              |
| `--json`           | `false`                        | Print a JSON result envelope to stdout instead of the reply text.                 |
| `--env <path>`     | `<project>/.env`, when present | Select one alternate `.env`-format file, loaded before the run. Shell values win. |

## Configuration and persistence

`flue run` discovers `flue.config.*` from the current working directory and honors its `target`, `app`, `db`, `cloudflare`, and `agents` fields; legacy fields such as `root` and `output` are ignored. It never reads `vite.config.ts`.

Persistence follows the project's `db.ts` convention:

- With a `db` entry (configured in `flue.config.ts` or discovered in the source root), conversations persist through that adapter — the same storage a deployed Node server uses.
- Without one, `flue run` uses a project-local SQLite file at `node_modules/.cache/flue/run.db`, so `--id` continues conversations across invocations without any setup.

```bash
flue run src/agents/support.ts --message "My checkout 500s." --id ticket-4821
flue run src/agents/support.ts --message "Any update?" --id ticket-4821   # same conversation
```

## Output contract

- **stdout** carries only the result: the final assistant reply text, or the `--json` envelope. Everything else — the run banner (agent, conversation id, config, db, env), the echoed user message, streamed agent activity, and any `console.log` output from the agent module — goes to stderr, so stdout is safe to pipe.
- The conversation id is always printed (stderr), including generated ones, so a follow-up `--id` invocation can continue the conversation.
- The conversation's uid is also printed (stderr) whenever the runtime reports one — pass it back as `--uid` on a later invocation to continue only that incarnation.

With `--json`, stdout receives one JSON object:

```json
{
  "id": "ticket-4821",
  "agent": "support",
  "submissionId": "f6654bff-d6ce-40d1-97a5-a150a7af6779",
  "outcome": "completed",
  "message": "The final assistant reply text.",
  "uid": "inst_01KW8Z3F9G6QK8P8V7YV5RJXWQ"
}
```

`id` is the conversation id, `agent` the module identity, `submissionId` the durable submission this run admitted, `outcome` always `"completed"` (failed and aborted runs print no envelope), `message` the final reply text, and `uid` the contacted instance's uid — minted on a creating run, echoed on a continuing one, omitted for instances created before uids shipped.

## Exit codes

| Code  | Meaning                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`   | The submission settled `completed`.                                                                                                            |
| `1`   | The submission settled `failed`, or setup failed (module resolution, config, persistence).                                                     |
| `130` | The run was aborted — Ctrl-C (SIGINT) aborts the in-flight work through the durable coordinator, waits for the aborted settlement, then exits. |
| `143` | Terminated by SIGTERM.                                                                                                                         |

## Environment files

Without `--env`, `flue run` loads `<project>/.env` when present (the project root is the `flue.config.*` directory, or the current working directory without one). `--env <path>` selects one alternate `.env`-format file instead. Values already present in the shell always win. `--env` accepts exactly one file.

## Dropped flags

The legacy HTTP-based `flue run <name>` flags were removed. Each one fails with a pointer at its replacement:

| Dropped                | Replacement                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `--input <json>`       | Pass the message text with `--message <text>`.                                                            |
| `--server`, `--header` | `flue run` executes in-process without HTTP. To call a deployed server, use the SDK (`createFlueClient`). |
| `--target`             | `flue run` is always Node-local.                                                                          |
| `--root`               | Run from the project directory; the module path resolves from the current working directory.              |
| `--output`             | `flue run` writes no build artifacts.                                                                     |
| `--config`             | `flue.config.*` is discovered from the current working directory.                                         |

Passing a bare name instead of a path (`flue run assistant`) also fails with a pointer: pass the module path, e.g. `flue run src/agents/assistant.ts`.

## Examples

```bash
flue run src/agents/hello.ts --message "Hi there"
flue run src/agents/hello.ts --message "And then?" --id support-4821 --env .env.staging
flue run src/agents/hello.ts --message "Run the demo." --json | jq -r .message
flue run src/agents/triage.ts --id issue-17307 --initial-data '{"issue": 17307}' --message "Triage."
flue run src/agents/triage.ts --id issue-17307 --uid inst_01KW8Z3F9G6QK8P8V7YV5RJXWQ --message "Re-check."
flue run src/agents/triage.ts --id issue-17307 --new --message "Triage."
```
