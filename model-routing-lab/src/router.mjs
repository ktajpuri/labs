import { runIntentMatcher } from "./intentMatcher.mjs";
import { runLocalModel, DEFAULT_MODEL } from "./localModel.mjs";
import { callClaudeExtraction, callClaude } from "./claude.mjs";
import { SIMPLE_EXTRACTION_SYSTEM_PROMPT, MEDIUM_SYSTEM_PROMPT, HARD_SYSTEM_PROMPT } from "./prompts.mjs";

// Generic, mechanical, pre-call classifier — no oracle tier label, no LLM
// self-report. Only signals a real system could read off the raw text before
// spending anything: how many distinct order IDs are mentioned, and whether
// dispute vocabulary is present. Deliberately NOT tuned to specific phrases
// in any one golden-set query (that would just be memorizing the answer key).
const ORDER_ID_RE = /\b1\d{4}\b/g;
const DISPUTE_RE = /\b(refund|return|eligible|damaged|defect|broken)\b/i;
const CONFIDENCE_THRESHOLD = 0.7; // knee identified in S7

export function classifyQuery(text) {
  const orderIds = new Set(text.match(ORDER_ID_RE) || []);
  const hasDispute = DISPUTE_RE.test(text);
  if (orderIds.size >= 2) return "complex";
  if (hasDispute) return "dispute";
  return "extraction";
}

// S12 fix: S11 found that a US zip code (e.g. "10021") matches the same
// \b1\d{4}\b shape as a real order ID, false-triggering the "2 order IDs"
// complex signal (S05). In every golden-set address, a zip code directly
// follows a 2-letter state abbreviation ("NY 10021"); no real order-ID
// mention is ever preceded by one. That positional cue — not the digits
// themselves — is what actually distinguishes the two, so exclude any
// candidate immediately preceded by a bare state-abbreviation-shaped token
// rather than trying to enumerate real zip codes.
const STATE_ABBREV_BEFORE_RE = /\b[A-Z]{2}\s*$/;

export function classifyQueryV2(text) {
  const allMatches = [...text.matchAll(ORDER_ID_RE)];
  const orderIds = new Set(
    allMatches
      .filter((m) => !STATE_ABBREV_BEFORE_RE.test(text.slice(Math.max(0, m.index - 6), m.index)))
      .map((m) => m[0]),
  );
  const hasDispute = DISPUTE_RE.test(text);
  if (orderIds.size >= 2) return "complex";
  if (hasDispute) return "dispute";
  return "extraction";
}

// Dry classification only — no LLM/API calls, free. Used as S11/S12's steady-state check.
export function routeQueryDry(text, classifier = classifyQuery) {
  const codePath = runIntentMatcher(text);
  if (codePath.matched) return { bucket: "code_path", classification: null };
  return { bucket: classifier(text), classification: classifier(text) };
}

// Full dispatch: runs the real tier and returns a report.mjs-shaped row plus
// enough info to grade against either gold type (structural or judge).
// `classifier` is swappable so S11 (buggy v1) and S12 (fixed v2) share one
// dispatch path instead of duplicating it.
export async function routeQuery(q, classifier = classifyQuery) {
  const codePath = runIntentMatcher(q.text);
  if (codePath.matched) {
    return {
      route: "code_path",
      responseText: codePath.response ?? "",
      fields: { order_id: codePath.orderId, intent: codePath.intent },
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      latencyMs: 0,
      note: codePath.response ?? codePath.reason,
    };
  }

  const bucket = classifier(q.text);

  if (bucket === "extraction") {
    const local = await runLocalModel(q.text, DEFAULT_MODEL);
    if (local.confidence === null || local.confidence < CONFIDENCE_THRESHOLD) {
      const sonnetR = await callClaudeExtraction("sonnet", SIMPLE_EXTRACTION_SYSTEM_PROMPT, q.text);
      return {
        route: "sonnet(esc)",
        responseText: JSON.stringify(sonnetR.fields),
        fields: sonnetR.fields,
        inputTokens: local.inputTokens + sonnetR.inputTokens,
        outputTokens: local.outputTokens + sonnetR.outputTokens,
        costUSD: local.costUSD + sonnetR.costUSD,
        latencyMs: local.latencyMs + sonnetR.latencyMs,
        note: `bucket=extraction conf=${local.confidence} ESCALATED`,
      };
    }
    return {
      route: "local",
      responseText: JSON.stringify(local.fields),
      fields: local.fields,
      inputTokens: local.inputTokens,
      outputTokens: local.outputTokens,
      costUSD: local.costUSD,
      latencyMs: local.latencyMs,
      note: `bucket=extraction conf=${local.confidence}`,
    };
  }

  if (bucket === "dispute") {
    const r = await callClaude("sonnet", MEDIUM_SYSTEM_PROMPT, q.text);
    return {
      route: "sonnet",
      responseText: r.text,
      fields: null,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUSD: r.costUSD,
      latencyMs: r.latencyMs,
      note: "bucket=dispute",
    };
  }

  // bucket === "complex"
  const r = await callClaude("opus", HARD_SYSTEM_PROMPT, q.text);
  return {
    route: "opus",
    responseText: r.text,
    fields: null,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUSD: r.costUSD,
    latencyMs: r.latencyMs,
    note: "bucket=complex",
  };
}
