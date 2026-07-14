import golden from "./golden-set.json" with { type: "json" };
import { runIntentMatcher } from "./src/intentMatcher.mjs";
import { runLocalModel } from "./src/localModel.mjs";
import { callClaude, callClaudeExtraction } from "./src/claude.mjs";
import { gradeStructural, gradeWithJudge } from "./src/grader.mjs";
import { runVerifier } from "./src/verifier.mjs";
import {
  TRIVIAL_LLM_SYSTEM_PROMPT,
  SIMPLE_EXTRACTION_SYSTEM_PROMPT,
  MEDIUM_SYSTEM_PROMPT,
  HARD_SYSTEM_PROMPT,
} from "./src/prompts.mjs";
import { printHeader, printRow, printTotals } from "./src/report.mjs";

const simpleQueries = golden.queries.filter((q) => q.tier === "simple");

// ---------- S1: Sonnet-only baseline, all 30 queries ----------
async function scenarioS1() {
  printHeader("S1: Baseline — all 30 queries -> Sonnet only");
  const rows = [];
  for (const q of golden.queries) {
    let row;
    if (q.tier === "trivial") {
      const r = await callClaudeExtraction("sonnet", TRIVIAL_LLM_SYSTEM_PROMPT, q.text);
      const grade = gradeStructural(r.fields, q.gold.expected_fields);
      row = mkRow(q, "sonnet", grade.correct, r, grade.correct ? "" : grade.details.join("; "));
    } else if (q.tier === "simple") {
      const r = await callClaudeExtraction("sonnet", SIMPLE_EXTRACTION_SYSTEM_PROMPT, q.text);
      const grade = gradeStructural(r.fields, q.gold.expected_fields);
      row = mkRow(q, "sonnet", grade.correct, r, grade.correct ? "" : grade.details.join("; "));
    } else {
      const sysPrompt = q.tier === "medium" ? MEDIUM_SYSTEM_PROMPT : HARD_SYSTEM_PROMPT;
      const r = await callClaude("sonnet", sysPrompt, q.text);
      const grade = await gradeWithJudge(q.text, q.gold.expected_outcome, r.text);
      row = {
        id: q.id,
        tier: q.tier,
        route: "sonnet",
        correct: grade.correct,
        inputTokens: r.inputTokens + grade.judgeInputTokens,
        outputTokens: r.outputTokens + grade.judgeOutputTokens,
        costUSD: r.costUSD + grade.judgeCostUSD,
        latencyMs: r.latencyMs,
        note: grade.reason ?? "",
      };
    }
    printRow(row);
    rows.push(row);
  }
  printTotals(rows);
}

// ---------- S2: code-path coverage, over the full golden set ----------
async function scenarioS2() {
  printHeader("S2: Code-path coverage — intent matcher alone, all 30 queries");
  const rows = [];
  let claimed = 0;
  let claimedCorrect = 0;
  for (const q of golden.queries) {
    const r = runIntentMatcher(q.text);
    let correct = null;
    if (r.matched) {
      claimed++;
      if (q.tier === "trivial") {
        correct =
          typeof r.correct === "boolean"
            ? r.correct
            : gradeStructural({ order_id: r.orderId, intent: r.intent }, q.gold.expected_fields).correct;
      } else {
        correct = false; // matched a non-trivial query => false claim by construction
      }
      if (correct) claimedCorrect++;
    }
    const row = {
      id: q.id,
      tier: q.tier,
      route: r.matched ? "code_path" : "unmatched",
      correct,
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      latencyMs: 0,
      note: r.matched ? r.response ?? "" : r.reason,
    };
    printRow(row);
    rows.push(row);
  }
  const falseClaims = claimed - claimedCorrect;
  console.log(
    `\n--- claim rate: ${claimed}/${rows.length} (${((claimed / rows.length) * 100).toFixed(1)}%) ` +
      `| false-claim rate among claimed: ${falseClaims}/${claimed || 1} (${((falseClaims / (claimed || 1)) * 100).toFixed(1)}%) ---\n`,
  );
}

// ---------- shared cascade core (used by S3 and S7) ----------
async function runConfidenceCascade(threshold, headerLabel) {
  printHeader(headerLabel ?? `Confidence cascade (threshold=${threshold})`);
  const rows = [];
  let escalated = 0;
  for (const q of simpleQueries) {
    const local = await runLocalModel(q.text);
    let finalFields = local.fields;
    let route = "local";
    let inputTokens = local.inputTokens;
    let outputTokens = local.outputTokens;
    let costUSD = local.costUSD;
    let latencyMs = local.latencyMs;
    let escalatedFlag = false;

    if (local.confidence === null || local.confidence < threshold) {
      escalated++;
      escalatedFlag = true;
      const sonnetR = await callClaudeExtraction("sonnet", SIMPLE_EXTRACTION_SYSTEM_PROMPT, q.text);
      finalFields = sonnetR.fields;
      route = "sonnet(esc)";
      inputTokens += sonnetR.inputTokens;
      outputTokens += sonnetR.outputTokens;
      costUSD += sonnetR.costUSD;
      latencyMs += sonnetR.latencyMs;
    }

    const grade = gradeStructural(finalFields, q.gold.expected_fields);
    const row = {
      id: q.id,
      tier: q.tier,
      route,
      correct: grade.correct,
      inputTokens,
      outputTokens,
      costUSD,
      latencyMs,
      note: `conf=${local.confidence} ${escalatedFlag ? "ESCALATED" : ""} ${grade.correct ? "" : grade.details.join("; ")}`,
    };
    printRow(row);
    rows.push(row);
  }
  const totals = printTotals(rows);
  console.log(`--- escalation rate: ${escalated}/${rows.length} (${((escalated / rows.length) * 100).toFixed(1)}%) ---\n`);
  return { rows, totals, escalated };
}

async function scenarioS3(threshold = 0.7) {
  return runConfidenceCascade(threshold, `S3: Cascade with self-reported confidence (threshold=${threshold}) — Simple tier`);
}

// ---------- S4 CORE: confidence calibration, local model alone ----------
async function scenarioS4() {
  printHeader("S4 CORE: confidence calibration — local model alone, Simple tier, no escalation");
  const rows = [];
  let wrongCount = 0;
  let confidentlyWrongCount = 0;
  for (const q of simpleQueries) {
    const local = await runLocalModel(q.text);
    const grade = gradeStructural(local.fields, q.gold.expected_fields);
    const isWrong = !grade.correct;
    if (isWrong) wrongCount++;
    const isConfidentlyWrong = isWrong && local.confidence !== null && local.confidence >= 0.7;
    if (isConfidentlyWrong) confidentlyWrongCount++;
    const row = {
      id: q.id,
      tier: q.tier,
      route: "local",
      correct: grade.correct,
      inputTokens: local.inputTokens,
      outputTokens: local.outputTokens,
      costUSD: 0,
      latencyMs: local.latencyMs,
      note: `conf=${local.confidence} ${isConfidentlyWrong ? "CONFIDENTLY WRONG" : ""} ${isWrong ? grade.details.join("; ") : ""}`,
    };
    printRow(row);
    rows.push(row);
  }
  printTotals(rows);
  console.log(
    `--- wrong: ${wrongCount}/${rows.length} | confidently wrong (conf>=0.7 AND wrong): ${confidentlyWrongCount}/${wrongCount || 1} of wrong answers ---\n`,
  );
}

// ---------- S5: verifier-based escalation ----------
async function scenarioS5() {
  printHeader("S5: Verifier-based escalation — Simple tier");
  const rows = [];
  let escalated = 0;
  for (const q of simpleQueries) {
    const local = await runLocalModel(q.text);
    const verifier = await runVerifier(local.fields);
    let finalFields = local.fields;
    let route = "local";
    let inputTokens = local.inputTokens + verifier.haikuInputTokens;
    let outputTokens = local.outputTokens + verifier.haikuOutputTokens;
    let costUSD = local.costUSD + verifier.haikuCostUSD;
    let latencyMs = local.latencyMs;
    let escalatedFlag = false;

    if (!verifier.verified) {
      escalated++;
      escalatedFlag = true;
      const sonnetR = await callClaudeExtraction("sonnet", SIMPLE_EXTRACTION_SYSTEM_PROMPT, q.text);
      finalFields = sonnetR.fields;
      route = "sonnet(esc)";
      inputTokens += sonnetR.inputTokens;
      outputTokens += sonnetR.outputTokens;
      costUSD += sonnetR.costUSD;
      latencyMs += sonnetR.latencyMs;
    }

    const grade = gradeStructural(finalFields, q.gold.expected_fields);
    const row = {
      id: q.id,
      tier: q.tier,
      route,
      correct: grade.correct,
      inputTokens,
      outputTokens,
      costUSD,
      latencyMs,
      note: `structOk=${verifier.structuralOk} haikuOk=${verifier.haikuOk} ${escalatedFlag ? "ESCALATED" : ""} ${grade.correct ? "" : grade.details.join("; ")}`,
    };
    printRow(row);
    rows.push(row);
  }
  const totals = printTotals(rows);
  console.log(`--- escalation rate: ${escalated}/${rows.length} (${((escalated / rows.length) * 100).toFixed(1)}%) ---\n`);
  return { rows, totals, escalated };
}

// ---------- S6: control, local vs Opus head-to-head ----------
async function scenarioS6() {
  printHeader("S6: Control — local model vs Opus head-to-head, Simple tier (8 queries)");
  const localRows = [];
  const opusRows = [];
  for (const q of simpleQueries) {
    const local = await runLocalModel(q.text);
    const localGrade = gradeStructural(local.fields, q.gold.expected_fields);
    localRows.push(mkRow(q, "local", localGrade.correct, local, localGrade.correct ? "" : localGrade.details.join("; ")));

    const opus = await callClaudeExtraction("opus", SIMPLE_EXTRACTION_SYSTEM_PROMPT, q.text);
    const opusGrade = gradeStructural(opus.fields, q.gold.expected_fields);
    opusRows.push(mkRow(q, "opus", opusGrade.correct, opus, opusGrade.correct ? "" : opusGrade.details.join("; ")));
  }
  console.log("-- local model --");
  localRows.forEach(printRow);
  const localTotals = printTotals(localRows);
  console.log("-- opus --");
  opusRows.forEach(printRow);
  const opusTotals = printTotals(opusRows);
  console.log(`--- accuracy: local ${localTotals.correctCount}/${localTotals.n} vs opus ${opusTotals.correctCount}/${opusTotals.n} ---\n`);
}

// ---------- S7: threshold boundary sweep ----------
async function scenarioS7() {
  printHeader("S7: Threshold boundary sweep — 0.5 / 0.7 / 0.9");
  const thresholds = [0.5, 0.7, 0.9];
  const summary = [];
  for (const t of thresholds) {
    const { totals, escalated } = await runConfidenceCascade(t, `S7 sweep — threshold=${t}`);
    summary.push({ threshold: t, accuracy: totals.correctCount / totals.n, cost: totals.totalCost, escalationRate: escalated / totals.n });
  }
  console.log("\n--- sweep summary ---");
  for (const s of summary) {
    console.log(
      `threshold=${s.threshold}  accuracy=${(s.accuracy * 100).toFixed(1)}%  escalation=${(s.escalationRate * 100).toFixed(1)}%  cost=$${s.cost.toFixed(5)}`,
    );
  }
}

function mkRow(q, route, correct, r, note) {
  return {
    id: q.id,
    tier: q.tier,
    route,
    correct,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUSD: r.costUSD,
    latencyMs: r.latencyMs,
    note,
  };
}

// ---------- CLI ----------
const scenario = process.argv[2];
const thresholdArg = process.argv.find((a) => a.startsWith("--threshold="));
const threshold = thresholdArg ? parseFloat(thresholdArg.split("=")[1]) : 0.7;

const SCENARIOS = {
  s1: scenarioS1,
  s2: scenarioS2,
  "steady-state": scenarioS2, // free, no API calls — the steady-state check
  s3: () => scenarioS3(threshold),
  s4: scenarioS4,
  s5: scenarioS5,
  s6: scenarioS6,
  s7: scenarioS7,
};

const fn = SCENARIOS[scenario];
if (!fn) {
  console.error(`Usage: node --env-file=../.env run.mjs <${Object.keys(SCENARIOS).join("|")}> [--threshold=0.7]`);
  process.exit(1);
}

await fn();
