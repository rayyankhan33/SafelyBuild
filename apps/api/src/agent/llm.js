// Language-model providers for the agent (HANDOFF.md part B).
//
// The agent loop (loop.js) talks to one small provider-neutral interface, so the model can be swapped
// without touching the loop, the tools or the tests:
//
//   provider.generate({ system, messages, tools }) -> { text, toolCalls, usage }
//
//   messages  [{ role: 'user', text }
//              { role: 'assistant', text, toolCalls: [{ id, name, args }] }
//              { role: 'tool', results: [{ id, name, result }] }]
//   tools     [{ name, description, parameters }]   parameters = JSON Schema object; [] = tools disabled
//   returns   text       string or null
//             toolCalls  [{ id, name, args }]  (empty when the model gives its final answer)
//             usage      { input_tokens, output_tokens }
//
// Providers: MockProvider (scripted, offline: tests and demos), GeminiProvider (Google Gemini, free-tier keys).

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
    if (!this.keys.length) throw new LlmError('no API keys configured');
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
 * Scripted provider for tests and offline demos. `script` is either an array of responses returned in
 * order, or a function (request, callNumber) -> response. Every request is kept in `.requests`.
 */
export class MockProvider {
  constructor(script) {
    this.name = 'mock';
    this.model = 'scripted';
    this.script = script;
    this.requests = [];
  }

  async generate(request) {
    this.requests.push(request);
    const n = this.requests.length - 1;
    const out = typeof this.script === 'function' ? await this.script(request, n) : this.script[n];
    if (!out) throw new LlmError(`mock script has no response for call ${n + 1}`);
    return { text: out.text ?? null, toolCalls: out.toolCalls ?? [], usage: out.usage ?? { input_tokens: 0, output_tokens: 0 } };
  }
}

/**
 * Google Gemini through the REST API (no SDK dependency; the API already uses global fetch everywhere).
 *
 * BEFORE IMPLEMENTING: read the current Gemini API reference for generateContent and function calling.
 * Model names, the free-tier limits and field names change; do not rely on memory. Expected shape at the
 * time of planning:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *   header  x-goog-api-key: <key>          (never put the key in the URL: URLs end up in logs)
 *   body    { systemInstruction: { parts: [{ text }] },
 *             contents: [{ role: 'user' | 'model', parts: [{ text } | { functionCall: { name, args } }
 *                                                           | { functionResponse: { name, response } }] }],
 *             tools: [{ functionDeclarations: [{ name, description, parameters }] }] }
 *   reply   candidates[0].content.parts[] with text and/or functionCall; usageMetadata.promptTokenCount /
 *           candidatesTokenCount
 * Mapping: role 'assistant' -> 'model'; a 'tool' message -> one 'user' content whose parts are
 * functionResponse objects ({ name, response: { result } }). Gemini returns no call id: make one
 * (`${name}:${stepIndex}:${i}`).
 * Behaviour: take a key from the pool; on 429 or a quota error rest that key and try the next (at most
 * pool.size attempts, then throw the pool's retryable error); on 5xx retry once; on other 4xx throw
 * LlmError with the status; time out each request with AbortSignal.timeout(timeoutMs). Set
 * `this.lastKeyIndex` so the run log can record which key was used (index only).
 * Acceptance: unit tests with an injected fetchImpl for (a) plain text answer, (b) function call round trip,
 * (c) 429 on key 0 then success on key 1, (d) all keys 429 -> retryable LlmError, (e) the key never appears
 * in a thrown message.
 */
export class GeminiProvider {
  constructor({ keys, model, timeoutMs = 60_000, fetchImpl = fetch, cooldownMs = 60_000 }) {
    if (!model) throw new LlmError('GEMINI_MODEL is not set');
    this.name = 'gemini';
    this.model = model;
    this.pool = new KeyPool(keys, { cooldownMs });
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
    this.lastKeyIndex = null;
  }

  async generate(_request) {
    throw new Error('TODO(opus): implement the Gemini generateContent call with key rotation as described above (task B2)');
  }
}

/** Build the provider named in `agentConfig` (config.agent). Unknown names are an error, not a silent mock. */
export function createProvider(agentConfig) {
  if (agentConfig.provider === 'gemini') {
    return new GeminiProvider({ keys: agentConfig.geminiKeys, model: agentConfig.geminiModel, timeoutMs: agentConfig.requestTimeoutMs });
  }
  if (agentConfig.provider === 'mock') {
    // Offline demo provider: a canned "the model is not configured" answer, so the UI path can be shown without a key.
    return new MockProvider(() => ({ text: 'The AI assistant is running in offline demo mode (no language model is configured).' }));
  }
  throw new LlmError(`unknown AGENT_PROVIDER "${agentConfig.provider}" (use "gemini" or "mock")`);
}
