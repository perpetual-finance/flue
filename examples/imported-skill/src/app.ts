import { Hono } from 'hono';
import withCustomBash from './agents/with-custom-bash.ts';
import withImportedSkill from './agents/with-imported-skill.ts';

const app = new Hono();
app.route('/agents/with-imported-skill', withImportedSkill.route());
app.route('/agents/with-custom-bash', withCustomBash.route());

export default app;
