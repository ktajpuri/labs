import { callClaude } from "./claude.mjs";
import { JUDGE_SYSTEM_PROMPT } from "./prompts.mjs";

function normalize(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

// Loose token-overlap match — good enough for "did it extract the address"
// without requiring byte-identical formatting.
function fuzzyContains(actual, expected) {
  const expectedTokens = normalize(expected);
  if (expectedTokens.length === 0) return true;
  const actualTokens = new Set(normalize(actual));
  const hits = expectedTokens.filter((t) => actualTokens.has(t)).length;
  return hits / expectedTokens.length >= 0.7;
}

// Trivial + Simple tiers: compare extracted fields against gold.expected_fields.
// Returns { correct, details }.
export function gradeStructural(actualFields, expectedFields) {
  const mismatches = [];
  for (const [key, expectedVal] of Object.entries(expectedFields)) {
    if (key === "note") continue;
    const actualVal = actualFields?.[key];
    if (key === "order_id" || key === "orderId") {
      const a = actualFields?.order_id ?? actualFields?.orderId;
      if (String(a) !== String(expectedVal)) {
        mismatches.push(`order_id: expected ${expectedVal}, got ${a}`);
      }
    } else if (key === "intent") {
      if (actualVal !== expectedVal) {
        mismatches.push(`intent: expected ${expectedVal}, got ${actualVal}`);
      }
    } else if (typeof expectedVal === "string" && expectedVal.length > 15) {
      // long-ish free text field (address) — fuzzy match
      if (!fuzzyContains(actualVal, expectedVal)) {
        mismatches.push(`${key}: expected to contain "${expectedVal}", got "${actualVal}"`);
      }
    } else {
      if (String(actualVal ?? "").toLowerCase() !== String(expectedVal).toLowerCase()) {
        mismatches.push(`${key}: expected ${expectedVal}, got ${actualVal}`);
      }
    }
  }
  return { correct: mismatches.length === 0, details: mismatches };
}

// Medium + Hard tiers: Sonnet judge against gold.expected_outcome.
// Judge always runs on Sonnet regardless of which tier produced the response,
// per the lab's frozen-rubric design.
export async function gradeWithJudge(queryText, expectedOutcome, actualResponseText) {
  const userText = `CUSTOMER QUERY:\n${queryText}\n\nRUBRIC (expected outcome):\n${expectedOutcome}\n\nAGENT RESPONSE:\n${actualResponseText}`;
  const result = await callClaude("sonnet", JUDGE_SYSTEM_PROMPT, userText);
  let verdict;
  try {
    verdict = JSON.parse(result.text);
  } catch {
    verdict = { verdict: "FAIL", reason: "judge output was not parseable JSON" };
  }
  return {
    correct: verdict.verdict === "PASS",
    reason: verdict.reason,
    judgeCostUSD: result.costUSD,
    judgeInputTokens: result.inputTokens,
    judgeOutputTokens: result.outputTokens,
  };
}
