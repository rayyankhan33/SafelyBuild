// Agent core (no database, no network): the loop, tool gating, key rotation, number grounding, prompts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/loop.js';
import { KeyPool, LlmError, MockProvider } from '../src/agent/llm.js';
import { TOOLS, executeTool, toolsForRole, validateArgs } from '../src/agent/tools.js';
import { checkGrounding } from '../src/agent/grounding.js';
import { JOBS, systemPrompt } from '../src/agent/jobs.js';

const call = (name, args = {}, id = name) => ({ id, name, args });

test('loop: runs the requested tool, feeds the result back, returns the answer', async () => {
  const provider = new MockProvider([
    { toolCalls: [call('get_dashboard')], usage: { input_tokens: 10, output_tokens: 2 } },
    { text: 'The project is 40 % complete.', usage: { input_tokens: 20, output_tokens: 6 } },
  ]);
  const seen = [];
  const out = await runAgent({
    provider, system: 's', messages: [{ role: 'user', text: 'status?' }], tools: toolsForRole('engineer'),
    executeTool: async (c) => { seen.push(c.name); return { ok: true, data: { percent_complete: 40 } }; },
  });
  assert.equal(out.status, 'answered');
  assert.equal(out.answer, 'The project is 40 % complete.');
  assert.deepEqual(seen, ['get_dashboard']);
  assert.deepEqual(out.usage, { input_tokens: 30, output_tokens: 8 });
  const second = provider.requests[1].messages;
  assert.equal(second.at(-1).role, 'tool');
  assert.deepEqual(second.at(-1).results[0].result, { ok: true, data: { percent_complete: 40 } });
  assert.equal(checkGrounding(out.answer, out.toolResults).grounded, true);
});

test('loop: stops at the step limit and forces a final answer with tools off', async () => {
  const provider = new MockProvider((req) => (req.toolChoice !== 'none' ? { toolCalls: [call('get_dashboard')] } : { text: 'Best effort answer.' }));
  const out = await runAgent({ provider, system: 's', messages: [{ role: 'user', text: 'q' }], tools: toolsForRole('engineer'),
    executeTool: async () => ({ ok: true, data: {} }), maxSteps: 3 });
  assert.equal(out.status, 'step_limit');
  assert.equal(out.answer, 'Best effort answer.');
  assert.equal(provider.requests.length, 4);
  assert.equal(provider.requests.at(-1).toolChoice, 'none');
});

test('loop: the tool-call budget is enforced', async () => {
  let ran = 0;
  const provider = new MockProvider([{ toolCalls: [call('a', {}, '1'), call('a', {}, '2'), call('a', {}, '3')] }, { text: 'done' }]);
  const out = await runAgent({ provider, system: 's', messages: [{ role: 'user', text: 'q' }], tools: [],
    executeTool: async () => { ran += 1; return { ok: true }; }, maxToolCalls: 2 });
  assert.equal(ran, 2);
  assert.equal(out.toolResults[2].result.ok, false);
});

test('tools: every tool is described, and investors get only the investor-safe subset', () => {
  for (const t of TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.description.length > 30 && t.parameters.type === 'object' && t.roles.length);
    assert.doesNotMatch(t.name, /^(set|update|delete|create|ack|write)/, 'tools are read-only');
  }
  const investor = toolsForRole('investor').map((t) => t.name);
  assert.deepEqual(investor.sort(), ['get_dashboard', 'get_forecast_history', 'whatif_pace']);
  assert.ok(toolsForRole('engineer').length === TOOLS.length);
  for (const job of Object.values(JOBS)) for (const name of job.tools ?? []) assert.ok(TOOLS.some((t) => t.name === name), name);
});

test('tools: bad model input is returned as an error, not thrown', async () => {
  const ctx = { user: { role: 'investor' } };
  assert.match((await executeTool(ctx, call('drop_tables'))).error, /unknown tool/);
  assert.match((await executeTool(ctx, call('get_defects'))).error, /not available/);
  assert.match((await executeTool(ctx, call('whatif_pace', {}))).error, /missing argument/);
  assert.match((await executeTool(ctx, call('whatif_pace', { pace_factor: 'fast' }))).error, /must be number/);
  assert.match((await executeTool({ user: { role: 'engineer' } }, call('get_dashboard'), ['get_hazards'])).error, /unknown tool/);
  assert.equal(validateArgs(TOOLS.find((t) => t.name === 'whatif_crews').parameters, { crews: 2.5 }), 'argument "crews" must be integer');
});

test('key pool: rotates, rests a rate-limited key, and reports when all are resting', () => {
  let t = 0;
  const pool = new KeyPool(['sk-one', 'sk-two', 'sk-one', ' '], { cooldownMs: 1000, now: () => t });
  assert.equal(pool.size, 2);
  assert.deepEqual([pool.next().key, pool.next().key, pool.next().key], ['sk-one', 'sk-two', 'sk-one']);
  pool.rest(1);
  assert.deepEqual([pool.next().index, pool.next().index], [0, 0]);
  pool.rest(0);
  assert.throws(() => pool.next(), (e) => e instanceof LlmError && e.retryable && e.status === 429 && !e.message.includes('sk-'));
  t = 1001;
  assert.match(pool.next().key, /^sk-/);
  assert.throws(() => new KeyPool([]), LlmError);
});

test('grounding: figures must come from tool results', () => {
  const results = [{ name: 'get_dashboard', result: { ok: true, data: { spi: 0.87, eac: 12_500_000, forecast_end: '2026-09-21', days_late: 143.2, text: 'overrun of PKR 3.40 lakh' } } }];
  const good = 'SPI is 0.87 (87 %). Forecast finish 2026-09-21, about 143 days late, final cost PKR 1.25 crore, overrun 3.4 lakh. Three actions follow.';
  assert.deepEqual(checkGrounding(good, results), { grounded: true, checked: 6, ungrounded: [] });
  // written-out dates are dates, not figures: "30 January 2027" must not flag 30
  const written = [{ name: 'd', result: { ok: true, data: { planned_end: '2027-01-30', text: 'finish 6 Mar 2027' } } }];
  assert.deepEqual(checkGrounding('Planned end 30 January 2027; forecast March 6, 2027 (6th March 2027).', written), { grounded: true, checked: 3, ungrounded: [] });
  assert.deepEqual(checkGrounding('It ends 31 January 2027.', written).ungrounded, ['2027-01-31']);
  // a large invented number must not match a percentage-sized fact through scaling
  assert.equal(checkGrounding('It is 9876.5 days late.', [{ name: 'x', result: { ok: true, data: { pct: 98.8 } } }]).grounded, false);
  const bad = checkGrounding('Finish 2026-10-01, 60 days late, in 2026.', results);
  assert.equal(bad.grounded, false);
  assert.deepEqual(bad.ungrounded, ['2026-10-01', 60]);
});

test('prompts: each job has a prompt per allowed audience and refuses others', () => {
  assert.match(systemPrompt('chat', 'investor'), /plain words/);
  assert.match(systemPrompt('daily_analyst', 'engineer'), /You can only read/);
  assert.throws(() => systemPrompt('recovery_planner', 'investor'), RangeError);
  assert.throws(() => systemPrompt('nope', 'engineer'), RangeError);
});
