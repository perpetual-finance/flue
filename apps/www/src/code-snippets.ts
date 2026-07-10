// Prompt copied to the user's clipboard by the "Copy Prompt" CTA in the hero.
export const COPY_PROMPT = `Read https://flueframework.com/start.md then help create my first agent...`;

export const HERO = `'use agent';
import { defineAgent, useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import triage from '../skills/triage/SKILL.md';
import verify from '../skills/verify/SKILL.md';
import { replyToIssue } from '../tools/github.ts';

// Expose (and protect) your agents to the world:
export const route = (c, next) => next();

// Compose the context your agent needs to do real work,
// complete with virtual, local, or remote container sandbox.
export default defineAgent(() => {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  useTool(replyToIssue);
  useSkill(triage);
  useSkill(verify);

  // Give agents the autonomy to solve complex tasks:
  return \`
Triage a bug report end-to-end: reproduce the bug,
diagnose the root cause, verify whether the behavior is
intentional, and attempt a fix.\`;
});`;
