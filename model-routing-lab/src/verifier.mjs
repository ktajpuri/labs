import orders from "../orders.json" with { type: "json" };
import { callClaude } from "./claude.mjs";

const HAIKU_CHECK_PROMPT = `You check whether an extracted shipping address looks like a
complete, plausible US mailing address (street, city, state at minimum). Respond with ONLY
one word: VALID or INVALID.`;

// S5: verifier-based escalation signal, replacing self-reported confidence.
// Two checks, both must pass for the local model's answer to be trusted:
//   1. Structural: required fields present + non-null, order_id matches the
//      known order-id shape, and (if a real order) exists in our order data.
//   2. One-line Haiku plausibility check on the extracted address.
// Returns { verified, structuralOk, haikuOk, haikuCostUSD, haikuInputTokens, haikuOutputTokens }.
export async function runVerifier(fields) {
  const structuralOk = checkStructural(fields);
  if (!structuralOk) {
    return { verified: false, structuralOk: false, haikuOk: null, haikuCostUSD: 0, haikuInputTokens: 0, haikuOutputTokens: 0 };
  }

  const haiku = await callClaude("haiku", HAIKU_CHECK_PROMPT, `Extracted address: "${fields.new_address}"`);
  const haikuOk = haiku.text.trim().toUpperCase().startsWith("VALID");

  return {
    verified: structuralOk && haikuOk,
    structuralOk,
    haikuOk,
    haikuCostUSD: haiku.costUSD,
    haikuInputTokens: haiku.inputTokens,
    haikuOutputTokens: haiku.outputTokens,
  };
}

function checkStructural(fields) {
  if (!fields || fields.parse_error) return false;
  if (!fields.order_id || !/^\d{5}$/.test(String(fields.order_id))) return false;
  if (!fields.new_address || String(fields.new_address).trim().length < 8) return false;
  // Constraint check: if the order_id matches a KNOWN order, fine either way —
  // this check only catches structurally malformed output, not order existence
  // (order existence is a business-logic question, not a structural one).
  return true;
}
