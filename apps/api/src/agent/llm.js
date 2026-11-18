// Language-model providers for the agent (docs/handoff-schedule-assistant.md part B).
//
// The agent loop (loop.js) talks to one small provider-neutral interface, so the model can be swapped
// without touching the loop, the tools or the tests:
//
//   provider.generate({ system, messages, tools, toolChoice }) -> { text, toolCalls, usage, raw }
//
//   messages   [{ role: 'user', text }
//               { role: 'assistant', text, toolCalls: [{ id, name, args }], raw }
//               { role: 'tool', results: [{ id, name, result }] }]
//   tools      [{ name, description, parameters }]   parameters = JSON Schema object
//   toolChoice 'auto' (default) or 'none' (tools stay declared but the model must answer in text)
//   returns    text       string or null
//              toolCalls  [{ id, name, args }]  (empty when the model gives its final answer)
//              usage      { input_tokens, output_tokens }
//              raw        provider-specific copy of the model turn; the loop hands it back unchanged on the
//                         next call (Gemini requires its thought signatures to be returned as received)
//
// Providers: MockProvider (scripted: tests), OfflineProvider (no model: demos without a key),
// GeminiProvider (Google Gemini REST API, one or more keys).

export class LlmError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Round-robin pool of API keys. A key that hits its rate limit is rested for `cooldownMs` and the next
 * one is used. Keys are never logged or stored: callers record only the key's index.
 */
export class KeyPool {
  constructor(keys, { cooldownMs = 60_000, now = Date.now } = {}) {
    this.keys = [...new Set((keys ?? []).map((k) => String(k).trim()).filter(Boolean))];
    if (!this.keys.length) throw new LlmError('no API keys configured (set GEMINI_API_KEYS in .env)');
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.restUntil = this.keys.map(() => 0);
    this.cursor = 0;
  }

  get size() { return this.keys.length; }

  /** The next usable key as { key, index }. Throws a retryable LlmError when every key is resting. */
  next() {
    const t = this.now();
    for (let i = 0; i < this.keys.length; i += 1) {
      const index = (this.cursor + i) % this.keys.length;
      if (this.restUntil[index] <= t) {
        this.cursor = (index + 1) % this.keys.length;
        return { key: this.keys[index], index };
      }
    }
    const waitMs = Math.min(...this.restUntil) - t;
    throw new LlmError(`every API key is rate-limited; retry in about ${Math.ceil(waitMs / 1000)} s`, { status: 429, retryable: true });
  }

  /** Rest key `index` (call on HTTP 429 or a quota error). */
  rest(index, ms = this.cooldownMs) {
    this.restUntil[index] = this.now() + ms;
  }
}

/**
 * Scripted provider for tests. `script` is either an array of responses returned in order, or a function
 * (request, callNumber) -> response. Every request is kept in `.requests`.
 */
export class MockProvider {
  constructor(script, { name = 'mock', model = 'scripted' } = {}) {
    this.name = name;
    this.model = model;
    this.script = script;
    this.requests = [];
    this.lastKeyIndex = null;
  }

  async generate(request) {
    this.requests.push(request);
    const n = this.requests.length - 1;
    const out = typeof this.script === 'function' ? await this.script(request, n) : this.script[n];
    if (out instanceof Error) throw out;
    if (!out) throw new LlmError(`mock script has no response for call ${n + 1}`);
    return { text: out.text ?? null, toolCalls: out.toolCalls ?? [], usage: out.usage ?? { input_tokens: 0, output_tokens: 0 }, raw: null };
  }
}

/**
 * No language model at all: used when AGENT_PROVIDER=offline (demos without a key or without internet).
 * It reads the dashboard through the same tool path and reports the headline numbers verbatim, so the
 * whole pipeline (tools, read-only transaction, grounding, storage, UI) can be shown. It does not reason.
 */
export class OfflineProvider {
  constructor() {
    this.name = 'offline';
    this.model = 'no-model';
    this.lastKeyIndex = null;
  }

  async generate({ messages, tools, toolChoice }) {
    const results = messages.filter((m) => m.role === 'tool').flatMap((m) => m.results);
    const dash = results.find((r) => r.name === 'get_dashboard' && r.result?.ok)?.result.data;
    if (!dash && toolChoice !== 'none' && tools.some((t) => t.name === 'get_dashboard')) {
      return { text: null, toolCalls: [{ id: 'offline:1', name: 'get_dashboard', args: {} }], usage: { input_tokens: 0, output_tokens: 0 }, raw: null };
    }
    const lines = ['Offline demo mode: no language model is configured, so this is a plain read-out of the dashboard, not an analysis.'];
    const h = dash?.headline;
    if (h) {
      lines.push(`Progress: ${h.percent_complete}% complete against ${h.planned_percent}% planned.`);
      if (h.schedule?.text) lines.push(`Schedule: ${h.schedule.text}`);
      if (h.budget?.text) lines.push(`Budget: ${h.budget.text}`);
      if (h.safety?.text) lines.push(`Safety: ${h.safety.text}`);
      for (const a of (dash.alerts ?? []).slice(0, 3)) lines.push(`Open alert: ${a.message}`);
    } else if (results.length) {
      lines.push('The data tools answered, but there is no dashboard summary to read out.');
    }
    if (tools.some((t) => t.name === 'get_frame_context')) {
      // evidence triage asks for a verdict line; without a model nothing can be judged, so a human must look
      lines.push('VERDICT: needs human review');
    }
    return { text: lines.join('\n'), toolCalls: [], usage: { input_tokens: 0, output_tokens: 0 }, raw: null };
  }
}

// ------------------------------------------------------------------------------------------- Gemini
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TYPE = { object: 'OBJECT', string: 'STRING', number: 'NUMBER', integer: 'INTEGER', boolean: 'BOOLEAN', array: 'ARRAY' };

/** JSON Schema (the subset tools.js uses) -> Gemini Schema object (uppercase types). */
export function toGeminiSchema(schema) {
  const out = {};
  if (schema.type) out.type = TYPE[schema.type] ?? String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum.map(String);
  if (schema.items) out.items = toGeminiSchema(schema.items);
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (!Object.keys(out.properties).length) delete out.properties;
  }
  if (schema.required?.length) out.required = schema.required;
  return out;
}

/** Provider-neutral messages -> Gemini `contents`. Model turns are replayed from `raw` when available. */
export function toGeminiContents(messages) {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', parts: [{ text: m.text }] };
    if (m.role === 'assistant') {
      if (m.raw?.parts) return { role: 'model', parts: m.raw.parts };
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls ?? []) parts.push({ functionCall: { name: c.name, args: c.args ?? {} } });
      return { role: 'model', parts };
    }
    if (m.role === 'tool') {
      return {
        role: 'user',
        parts: m.results.map((r) => ({
          functionResponse: { name: r.name, ...(String(r.id).startsWith('gen:') ? {} : { id: r.id }), response: { result: r.result } },
        })),
      };
    }
    throw new LlmError(`unknown message role "${m.role}"`);
  });
}

/** Gemini response -> provider-neutral result. */
export function fromGeminiResponse(body, step = 0) {
  const cand = body?.candidates?.[0];
  if (!cand) {
    const reason = body?.promptFeedback?.blockReason;
    throw new LlmError(reason ? `the model refused the request (${reason})` : 'the model returned no answer');
  }
  if (cand.finishReason === 'MALFORMED_FUNCTION_CALL') throw new LlmError('the model produced a malformed tool call', { retryable: true });
  const parts = cand.content?.parts ?? [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => ({
    id: p.functionCall.id ?? `gen:${p.functionCall.name}:${step}:${i}`,
    name: p.functionCall.name,
    args: p.functionCall.args ?? {},
  }));
  if (!text && !toolCalls.length && ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(cand.finishReason)) {
    throw new LlmError(`the model stopped for safety reasons (${cand.finishReason})`);
  }
  const u = body.usageMetadata ?? {};
  return {
    text: text || null,
    toolCalls,
    usage: { input_tokens: u.promptTokenCount ?? 0, output_tokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) },
    raw: { parts },
  };
}

/** "30s" / "1.5s" -> milliseconds; Google puts the retry delay in error.details[].retryDelay. */
function retryDelayMs(body) {
  const d = (body?.error?.details ?? []).find((x) => typeof x?.retryDelay === 'string')?.retryDelay;
  const s = d ? Number.parseFloat(d) : NaN;
  return Number.isFinite(s) ? Math.min(Math.max(s * 1000, 1000), 10 * 60_000) : null;
}

/**
 * Google Gemini through the REST generateContent endpoint (no SDK; global fetch).
 * The key goes in the `x-goog-api-key` header, never in the URL. On HTTP 429 the key is rested and the next
 * key of the pool is tried; a 5xx is retried once. Errors never contain a key.
 */
export class GeminiProvider {
  constructor({ keys, model, timeoutMs = 60_000, fetchImpl = fetch, cooldownMs = 60_000, thinkingLevel = '', sleep }) {
    if (!model) throw new LlmError('GEMINI_MODEL is not set');
    this.name = 'gemini';
    this.model = model;
    this.pool = new KeyPool(keys, { cooldownMs });
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.thinkingLevel = thinkingLevel;
    this.lastKeyIndex = null;
    this.calls = 0;
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  body({ system, messages, tools = [], toolChoice = 'auto' }) {
    const body = { contents: toGeminiContents(messages) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];
      body.toolConfig = { functionCallingConfig: { mode: toolChoice === 'none' ? 'NONE' : 'AUTO' } };
    }
    if (this.thinkingLevel) body.generationConfig = { thinkingConfig: { thinkingLevel: this.thinkingLevel } };
    return body;
  }

  scrub(text) {
    let s = String(text ?? '');
    for (const k of this.pool.keys) s = s.split(k).join('***');
    return s;
  }

  async generate(request) {
    const payload = JSON.stringify(this.body(request));
    const url = `${GEMINI_BASE}/${encodeURIComponent(this.model)}:generateContent`;
    const step = this.calls++;
    let serverRetry = false;
    for (let attempt = 0; attempt < this.pool.size + 1; attempt += 1) {
      const { key, index } = this.pool.next(); // throws a retryable LlmError when every key is resting
      let res;
      try {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: payload,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        throw new LlmError(e?.name === 'TimeoutError' ? 'the language model timed out' : `the language model is unreachable (${this.scrub(e?.cause?.code ?? e?.message)})`, { retryable: true });
      }
      this.lastKeyIndex = index;
      let body = null;
      try { body = await res.json(); } catch { /* keep null */ }
      if (res.ok) return fromGeminiResponse(body, step);
      const msg = this.scrub(body?.error?.message ?? res.statusText ?? `HTTP ${res.status}`);
      if (res.status === 429) {
        this.pool.rest(index, retryDelayMs(body) ?? this.pool.cooldownMs);
        continue;
      }
      if (res.status >= 500 && !serverRetry) {
        serverRetry = true;
        await this.sleep(1000);
        continue;
      }
      throw new LlmError(`the language model refused the request (${res.status}): ${msg}`, { status: res.status, retryable: res.status >= 500 });
    }
    return this.pool.next(); // unreachable in practice: next() throws when all keys rest
  }
}

/** Build the provider named in `agentConfig` (config.agent). Unknown names are an error, not a silent fallback. */
export function createProvider(agentConfig) {
  if (agentConfig.provider === 'gemini') {
    return new GeminiProvider({
      keys: agentConfig.geminiKeys, model: agentConfig.geminiModel, timeoutMs: agentConfig.requestTimeoutMs,
      thinkingLevel: agentConfig.geminiThinkingLevel,
    });
  }
  if (agentConfig.provider === 'offline' || agentConfig.provider === 'mock') return new OfflineProvider();
  throw new LlmError(`unknown AGENT_PROVIDER "${agentConfig.provider}" (use "gemini" or "offline")`);
}
