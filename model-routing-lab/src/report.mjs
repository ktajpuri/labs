// Shared row/totals printing so every scenario's output is comparable.

export function printHeader(title) {
  console.log(`\n=== ${title} ===\n`);
}

export function printRow(row) {
  const {
    id,
    tier,
    route,
    correct,
    inputTokens = 0,
    outputTokens = 0,
    costUSD = 0,
    latencyMs = 0,
    note = "",
  } = row;
  const mark = correct === true ? "✓" : correct === false ? "✗" : "-";
  console.log(
    `${mark} ${id.padEnd(4)} tier=${tier.padEnd(7)} route=${route.padEnd(8)} ` +
      `tokens=${String(inputTokens).padStart(4)}/${String(outputTokens).padEnd(4)} ` +
      `cost=$${costUSD.toFixed(5)} latency=${latencyMs.toFixed(0)}ms ${note}`,
  );
}

export function printTotals(rows) {
  const n = rows.length;
  const correctCount = rows.filter((r) => r.correct === true).length;
  const totalCost = rows.reduce((s, r) => s + (r.costUSD ?? 0), 0);
  const totalInputTokens = rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0);
  const totalOutputTokens = rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0);
  const avgLatency = rows.reduce((s, r) => s + (r.latencyMs ?? 0), 0) / n;
  console.log(
    `\n--- totals: n=${n} correct=${correctCount}/${n} (${((correctCount / n) * 100).toFixed(1)}%) ` +
      `cost=$${totalCost.toFixed(5)} tokens=${totalInputTokens}/${totalOutputTokens} ` +
      `avgLatency=${avgLatency.toFixed(0)}ms ---\n`,
  );
  return { n, correctCount, totalCost, totalInputTokens, totalOutputTokens, avgLatency };
}
