// Per-token pricing, $/1M tokens (cached 2026-06-24 from the claude-api skill).
// Local model cost is $0 — it runs on your machine.
export const PRICING = {
  sonnet: { input: 3.0, output: 15.0 },
  opus: { input: 5.0, output: 25.0 },
  haiku: { input: 1.0, output: 5.0 },
  local: { input: 0, output: 0 },
  code_path: { input: 0, output: 0 },
};

export function costUSD(tier, inputTokens, outputTokens) {
  const p = PRICING[tier];
  if (!p) throw new Error(`unknown pricing tier: ${tier}`);
  return (inputTokens / 1_000_000) * p.input + (outputTokens / 1_000_000) * p.output;
}
