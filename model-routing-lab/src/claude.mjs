import Anthropic from "@anthropic-ai/sdk";
import { costUSD } from "./pricing.mjs";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

const MODEL_IDS = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
  haiku: "claude-haiku-4-5",
};

// tier: "sonnet" | "opus" | "haiku"
export async function callClaude(tier, systemPrompt, userText) {
  const model = MODEL_IDS[tier];
  if (!model) throw new Error(`unknown claude tier: ${tier}`);

  const start = performance.now();
  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: "user", content: userText }],
  });
  const latencyMs = performance.now() - start;

  const text = response.content.find((b) => b.type === "text")?.text ?? "";
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    text,
    inputTokens,
    outputTokens,
    costUSD: costUSD(tier, inputTokens, outputTokens),
    latencyMs,
  };
}

// Same-shaped return as localModel.runLocalModel(), so any Claude tier can
// stand in for the local model in the router (S1 baseline, S6 control).
export async function callClaudeExtraction(tier, systemPrompt, userText) {
  const result = await callClaude(tier, systemPrompt, userText);
  let parsed;
  try {
    parsed = JSON.parse(result.text);
  } catch {
    parsed = { parse_error: true, raw: result.text };
  }
  return {
    fields: parsed,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
    latencyMs: result.latencyMs,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUSD: result.costUSD,
  };
}
