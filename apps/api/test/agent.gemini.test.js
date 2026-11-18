// Gemini provider and offline provider (TC-AGENT-GEMINI): no network, fetch is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/loop.js';
import { GeminiProvider, LlmError, OfflineProvider, createProvider, toGeminiSchema } from '../src/agent/llm.js';
import { toolsForRole } from '../src/agent/tools.js';
import { checkGrounding } from '../src/agent/grounding.js';

const KEYS = ['AIzaFAKEKEY000000000000000000000000one', 'AIzaFAKEKEY000000000000000000000000two'];
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses[calls.length - 1];
    if (!r) throw new Error('no more fake responses');
    return { ok: r.status === 200, status: r.status, statusText: 'x', json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}
const textReply = (text) => ({ status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, thoughtsTokenCount: 2 } } });
const ask = { messages: [{ role: 'user', text: 'x' }], tools: [] };

test('plain answer; the key goes in a header, never the URL; usage counted', async () => {
  const f = fakeFetch([textReply('All good.')]);
  const p = new GeminiProvider({ keys: KEYS, model: 'gemini-test', fetchImpl: f, thinkingLevel: 'MINIMAL' });
  const out = await p.generate({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: toolsForRole('investor') });
  assert.equal(out.text, 'All good.');
  assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 5 });
  const c = f.calls[0];
  assert.match(c.url, /models\/gemini-test:generateContent$/);
  assert.ok(!c.url.includes('AIza'));
  assert.equal(c.headers['x-goog-api-key'], KEYS[0]);
  assert.equal(c.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(c.body.tools[0].functionDeclarations.length, 3);
  assert.equal(c.body.tools[0].functionDeclarations[0].parameters.type, 'OBJECT');
  assert.equal(c.body.toolConfig.functionCallingConfig.mode, 'AUTO');
  assert.equal(c.body.generationConfig.thinkingConfig.thinkingLevel, 'MINIMAL');
});

test('function call round trip: model parts come back unchanged (thought signature), result as functionResponse', async () => {
  const callPart = { functionCall: { name: 'get_dashboard', args: {}, id: 'fc_1' }, thoughtSignature: 'SIG-abc' };
  const f = fakeFetch([
    { status: 200, body: { candidates: [{ content: { role: 'model', parts: [callPart] }, finishReason: 'STOP' }] } },
    textReply('Done: 40 % complete.'),
  ]);
  const p = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: f });
  const out = await runAgent({ provider: p, system: 's', messages: [{ role: 'user', text: 'status?' }], tools: toolsForRole('engineer'),
    executeTool: async () => ({ ok: true, data: { percent_complete: 40 } }) });
  assert.equal(out.answer, 'Done: 40 % complete.');
  const second = f.calls[1].body.contents;
  assert.deepEqual(second[1], { role: 'model', parts: [callPart] });
  assert.deepEqual(second[2], { role: 'user', parts: [{ functionResponse: { name: 'get_dashboard', id: 'fc_1', response: { result: { ok: true, data: { percent_complete: 40 } } } } }] });
});

test('a call without an id gets a generated one that is not sent back as an id', async () => {
  const f = fakeFetch([
    { status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'get_dashboard', args: {} } }] } }] } },
    textReply('ok'),
  ]);
  const p = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: f });
  await runAgent({ provider: p, system: 's', messages: [{ role: 'user', text: 'q' }], tools: toolsForRole('engineer'), executeTool: async () => ({ ok: true }) });
  assert.deepEqual(Object.keys(f.calls[1].body.contents[2].parts[0].functionResponse).sort(), ['name', 'response']);
});

test('429 on one key moves to the next; all keys limited gives a retryable error without the key', async () => {
  const limited = { status: 429, body: { error: { code: 429, message: `quota exceeded for ${KEYS[0]}`, status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '20s' }] } } };
  const f = fakeFetch([limited, textReply('ok')]);
  const p = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: f });
  assert.equal((await p.generate(ask)).text, 'ok');
  assert.equal(f.calls[1].headers['x-goog-api-key'], KEYS[1]);
  assert.equal(p.lastKeyIndex, 1);

  const q = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: fakeFetch([limited, limited, limited]) });
  await assert.rejects(q.generate(ask), (e) => e instanceof LlmError && e.retryable && e.status === 429 && !e.message.includes('AIza'));
});

test('other errors carry no key; a 5xx is retried once; a blocked prompt is refused', async () => {
  const bad = { status: 400, body: { error: { message: `API key not valid: ${KEYS[0]}` } } };
  const p = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: fakeFetch([bad]) });
  await assert.rejects(p.generate(ask), (e) => e.status === 400 && e.message.includes('***') && !e.message.includes('AIza'));
  const flaky = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: fakeFetch([{ status: 503, body: {} }, textReply('back')]), sleep: async () => {} });
  assert.equal((await flaky.generate(ask)).text, 'back');
  const blocked = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: fakeFetch([{ status: 200, body: { promptFeedback: { blockReason: 'SAFETY' } } }]) });
  await assert.rejects(blocked.generate(ask), /refused the request \(SAFETY\)/);
  const down = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(down.generate(ask), (e) => e instanceof LlmError && /unreachable \(ENOTFOUND\)/.test(e.message));
});

test('forced final answer keeps the tools declared with mode NONE; schema conversion; provider factory', () => {
  const p = new GeminiProvider({ keys: KEYS, model: 'm', fetchImpl: fakeFetch([]) });
  const body = p.body({ messages: [{ role: 'user', text: 'x' }], tools: toolsForRole('engineer'), toolChoice: 'none' });
  assert.equal(body.toolConfig.functionCallingConfig.mode, 'NONE');
  assert.deepEqual(toGeminiSchema({ type: 'object', properties: { n: { type: 'integer', description: 'd' }, s: { type: 'string', enum: ['a'] } }, required: ['n'] }),
    { type: 'OBJECT', properties: { n: { type: 'INTEGER', description: 'd' }, s: { type: 'STRING', enum: ['a'] } }, required: ['n'] });
  assert.throws(() => new GeminiProvider({ keys: [], model: 'm' }), LlmError);
  assert.ok(createProvider({ provider: 'offline' }) instanceof OfflineProvider);
  assert.throws(() => createProvider({ provider: 'nope' }), LlmError);
});

test('offline provider reads the dashboard through the tool path and says it is not an analysis', async () => {
  const out = await runAgent({ provider: new OfflineProvider(), system: 's', messages: [{ role: 'user', text: 'q' }], tools: toolsForRole('investor'),
    executeTool: async () => ({ ok: true, data: { headline: { percent_complete: 31.65, planned_percent: 39.91, schedule: { text: 'Late.' } }, alerts: [] } }) });
  assert.equal(out.status, 'answered');
  assert.match(out.answer, /Offline demo mode/);
  assert.match(out.answer, /31\.65% complete against 39\.91% planned/);
  assert.equal(checkGrounding(out.answer, out.toolResults).grounded, true);
});
