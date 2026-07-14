import { SIMPLE_EXTRACTION_SYSTEM_PROMPT } from "./prompts.mjs";

const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
const MODEL = "llama3.2:3b";

// Calls the local Ollama model. Returns structured output + timing/token
// usage + the model's self-reported confidence (S3/S4's subject under test).
export async function runLocalModel(queryText) {
  const start = performance.now();
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
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
