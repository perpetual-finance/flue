# `@flue/dev-console`

Experimental terminal client for interacting with a running Flue application.

This package is intentionally separate from `@flue/cli`. It does not discover projects, start a development server, or load `.env` files. Start the application separately and provide the absolute URL where the agent's routes are mounted (wherever the application's `app.ts` mounts `agent.route()`).

## Usage

Start the application in one terminal:

```sh
pnpm exec vite dev
```

Attach in another terminal by pointing the console at the agent's mount URL. The console opens one conversation at `<agent-url>/<id>`, generating a fresh conversation id when `--id` is omitted:

```sh
pnpm exec flue-dev-console http://127.0.0.1:5173/agents/support

pnpm exec flue-dev-console http://127.0.0.1:5173/agents/support \
  --id support-demo \
  --input '{"message":"Summarize the open tickets."}'
```

## Options

```text
--id <id>              Conversation id appended to the agent URL; generated when omitted
--input <json>         Initial message ({"message": "...", "images": [...]})
--token <token>        Bearer token sent with every request
--header 'Name: value' Repeatable request header
--help                 Show usage
--version              Show package version
```

`--input` must be a JSON object with a string `message` and optional `images`. The console stays open for follow-up prompts on the same conversation.

`@flue/dev-console` is experimental. Its command-line interface and presentation may change without notice.
