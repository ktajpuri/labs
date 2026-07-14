import { SIMPLE_EXTRACTION_SYSTEM_PROMPT } from "./prompts.mjs";

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
export const DEFAULT_MODEL = "llama3.2:3b";

// Calls the local Ollama model. Returns structured output + timing/token
// usage + the model's self-reported confidence (S3/S4's subject under test).
// `model` is overridable so the same harness can drive a weaker/stronger
// local model without duplicating this file (used by the 1B follow-up lab).
export async function runLocalModel(queryText, model = DEFAULT_MODEL) {
  const start = performance.now();
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system: SIMPLE_EXTRACTION_SYSTEM_PROMPT,
      prompt: queryText,
      format: "json",
      stream: false,
      options: { temperature: 0 },
    }),
  });
  if (!res.ok) {
    throw new Error(`ollama request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const latencyMs = performance.now() - start;

  let parsed;
  try {
    parsed = JSON.parse(data.response);
  } catch {
    parsed = { parse_error: true, raw: data.response };
  }

  return {
    fields: parsed,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    latencyMs,
    inputTokens: data.prompt_eval_count ?? 0,
    outputTokens: data.eval_count ?? 0,
    costUSD: 0,
  };
}
