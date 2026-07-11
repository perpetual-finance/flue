---
title: SDK overview
description: Reference for consuming deployed Flue agent conversations with @flue/sdk.
lastReviewedAt: 2026-07-02
---

The client SDK is exported from `@flue/sdk`. Use it from applications that consume deployed Flue agents.

A client addresses exactly one agent conversation by URL. The framework does not know where an application mounts its agents — the application's route map (`app.ts`) does — so the URL is wherever the agent's router (`createAgentRouter(...)`) is mounted, plus a caller-chosen conversation id:

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/triage/123456',
  token: process.env.FLUE_TOKEN,
});

const admission = await conversation.send({
  message: { kind: 'user', body: 'New bug report: checkout 500s on submit.' },
});
await conversation.wait(admission);
const { messages } = await conversation.history();
```

Starting a new conversation is constructing a client with a fresh id appended to the mount URL. There is no name/id addressing and no deployment-wide client.

## Client

[`createFlueClient(...)`](/docs/sdk/client/) creates the conversation handle: `send()`, `wait()`, `observe()`, `history()`, `abort()`, and `attachmentUrl()`.

## Shared types

- [Events and records](/docs/sdk/events/) describes observable runtime events and normalized model-turn data.
- [Errors](/docs/sdk/errors/) describes HTTP and stream errors.

## React

For chat UIs, `useFlueAgent({ url })` from `@flue/react` wraps this client with maintained conversation state. See [React](/docs/guide/react/).
