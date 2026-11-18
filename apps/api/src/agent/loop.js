// The agent loop: ask the model, run the tools it asks for, give it the results, repeat until it answers.
//
// This is deliberately small and provider-neutral (see llm.js). Limits are hard: a run can never take more
// than `maxSteps` model calls or `maxToolCalls` tool executions, and stops at `deadlineMs`. When a limit is
// reached the model gets one last call with tools switched off, so the user still receives an answer built
// from what was gathered, marked with status 'step_limit'.

export const LOOP_DEFAULTS = { maxSteps: 8, maxToolCalls: 16, deadlineMs: 120_000 };

/**
 * @param {object}   o
 * @param {object}   o.provider     llm.js provider
 * @param {string}   o.system       system prompt
 * @param {object[]} o.messages     conversation so far; the last one is the new user message
 * @param {object[]} o.tools        tool definitions the model may call [{ name, description, parameters }]
 * @param {(call: {id, name, args}) => Promise<object>} o.executeTool  returns a JSON-serialisable result;
 *                                  must not throw for bad model input (return { ok: false, error } instead)
 * @param {(step: object) => void} [o.onStep]  called after every model call (for logging / streaming)
 * @returns {Promise<{status: 'answered'|'step_limit'|'deadline', answer: string, steps: object[],
 *                    toolResults: object[], usage: {input_tokens: number, output_tokens: number}}>}
 */
export async function runAgent({ provider, system, messages, tools, executeTool, onStep, now = Date.now,
  maxSteps = LOOP_DEFAULTS.maxSteps, maxToolCalls = LOOP_DEFAULTS.maxToolCalls, deadlineMs = LOOP_DEFAULTS.deadlineMs }) {
  const convo = [...messages];
  const steps = [];
  const toolResults = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  const started = now();
  let toolCallsMade = 0;

  const ask = async (toolList) => {
    const out = await provider.generate({ system, messages: convo, tools: toolList });
    usage.input_tokens += out.usage?.input_tokens ?? 0;
    usage.output_tokens += out.usage?.output_tokens ?? 0;
    return out;
  };
  const finish = (status, answer) => ({ status, answer: (answer ?? '').trim(), steps, toolResults, usage });

  for (let i = 0; i < maxSteps; i += 1) {
    if (now() - started > deadlineMs) return forceAnswer('deadline');
    const out = await ask(tools);
    const step = { index: i, text: out.text, tool_calls: out.toolCalls.map((c) => ({ name: c.name, args: c.args })) };
    steps.push(step);
    onStep?.(step);
    if (!out.toolCalls.length) return finish('answered', out.text);

    convo.push({ role: 'assistant', text: out.text, toolCalls: out.toolCalls });
    const results = [];
    for (const call of out.toolCalls) {
      let result;
      if (toolCallsMade >= maxToolCalls) {
        result = { ok: false, error: 'tool-call budget for this run is used up; answer with what you have' };
      } else {
        toolCallsMade += 1;
        result = await executeTool(call);
      }
      results.push({ id: call.id, name: call.name, result });
      toolResults.push({ name: call.name, args: call.args, result });
    }
    convo.push({ role: 'tool', results });
  }
  return forceAnswer('step_limit');

  async function forceAnswer(status) {
    convo.push({ role: 'user', text: 'Stop calling tools. Give your final answer now, using only the tool results above. Say plainly what you could not check.' });
    const out = await ask([]);
    steps.push({ index: steps.length, text: out.text, tool_calls: [], forced: true });
    return finish(status, out.text);
  }
}
