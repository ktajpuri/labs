// Top-K comparator: from the SAME lab.minute_counts table, computes the
// window's top-K two ways and prints them side by side.
//
//   CORRECT       sum exact per-minute counts over the whole window, then rank.
//   NAIVE         keep only each minute's own top-K' rows, merge, then rank.
//   NAIVE-TIERED  (--tiered) cascade the same cut minute -> 30m -> day.
//
// Usage:
//   node query/topk.js --window 1m|30m|1h|1d [--k 10] [--retain K'] [--tiered]
//
const { createClient } = require('@clickhouse/client');
const cfg = require('../lib/topk-config');

const args = parseArgs(process.argv.slice(2));
const windowFlag = args.window || '1h';
const k = Number(args.k || 10);
const retain = Number(args.retain || k);
const tiered = !!args.tiered;

const WINDOW_MINUTES = { '1m': 1, '30m': 30, '1h': 60, '1d': 1440 };
if (!(windowFlag in WINDOW_MINUTES)) {
  console.error(`--window must be one of: ${Object.keys(WINDOW_MINUTES).join(', ')}`);
  process.exit(1);
}
const windowMinutes = WINDOW_MINUTES[windowFlag];

const ch = createClient(cfg.clickhouse);

async function rows(query) {
  const rs = await ch.query({ query, format: 'JSONEachRow' });
  return rs.json();
}

async function main() {
  const boundsRows = await rows(`SELECT max(window_end) AS end FROM minute_counts WHERE item_id != '${cfg.flushKey}'`);
  const end = boundsRows[0]?.end;
  if (!end) { console.log('(no rows yet in lab.minute_counts — is the sink running and has a window fired?)'); process.exit(0); }
  const start = `toDateTime64('${end}', 3) - INTERVAL ${windowMinutes} MINUTE`;
  const endExpr = `toDateTime64('${end}', 3)`;

  const bucketRows = await rows(`
    SELECT count(DISTINCT window_start) AS buckets
    FROM minute_counts
    WHERE window_start >= ${start} AND window_start <= ${endExpr} AND item_id != '${cfg.flushKey}'`);
  const buckets = Number(bucketRows[0]?.buckets || 0);

  const dupRows = await rows(`
    SELECT window_start, item_id, count() AS c
    FROM minute_counts
    WHERE window_start >= ${start} AND window_start <= ${endExpr} AND item_id != '${cfg.flushKey}'
    GROUP BY window_start, item_id
    HAVING c > 1
    ORDER BY window_start
    LIMIT 5`);

  const correct = await rows(`
    SELECT item_id, sum(cnt) AS total
    FROM minute_counts
    WHERE window_start >= ${start} AND window_start <= ${endExpr} AND item_id != '${cfg.flushKey}'
    GROUP BY item_id
    ORDER BY total DESC
    LIMIT 50`);

  const naiveQuery = tiered ? `
    WITH minute_ranked AS (
      SELECT window_start, item_id, cnt,
             row_number() OVER (PARTITION BY window_start ORDER BY cnt DESC) AS rn
      FROM minute_counts
      WHERE window_start >= ${start} AND window_start <= ${endExpr} AND item_id != '${cfg.flushKey}'
    ),
    minute_survivors AS (
      SELECT window_start, item_id, cnt FROM minute_ranked WHERE rn <= ${retain}
    ),
    tier30 AS (
      SELECT toStartOfInterval(window_start, INTERVAL 30 MINUTE) AS tier_start, item_id, sum(cnt) AS cnt
      FROM minute_survivors
      GROUP BY tier_start, item_id
    ),
    tier30_ranked AS (
      SELECT tier_start, item_id, cnt,
             row_number() OVER (PARTITION BY tier_start ORDER BY cnt DESC) AS rn
      FROM tier30
    ),
    tier30_survivors AS (
      SELECT tier_start, item_id, cnt FROM tier30_ranked WHERE rn <= ${retain}
    )
    SELECT item_id, sum(cnt) AS total
    FROM tier30_survivors
    GROUP BY item_id
    ORDER BY total DESC
    LIMIT 50` : `
    WITH minute_ranked AS (
      SELECT window_start, item_id, cnt,
             row_number() OVER (PARTITION BY window_start ORDER BY cnt DESC) AS rn
      FROM minute_counts
      WHERE window_start >= ${start} AND window_start <= ${endExpr} AND item_id != '${cfg.flushKey}'
    )
    SELECT item_id, sum(cnt) AS total
    FROM minute_ranked
    WHERE rn <= ${retain}
    GROUP BY item_id
    ORDER BY total DESC
    LIMIT 50`;

  const naive = await rows(naiveQuery);

  const correctTop = correct.slice(0, k);
  const naiveTop = naive.slice(0, k);
  const naiveByItem = new Map(naive.map((r) => [r.item_id, Number(r.total)]));
  const correctByItem = new Map(correct.map((r) => [r.item_id, Number(r.total)]));

  console.log(`\n===== top-${k}  window=${windowFlag} (${windowMinutes}min, ${buckets} buckets scanned)  retain(K')=${retain}${tiered ? '  [TIERED: minute -> 30m -> day]' : ''} =====\n`);

  const width = Math.max(...correctTop.map((r) => r.item_id.length), ...naiveTop.map((r) => r.item_id.length), 10);
  const naiveLabel = tiered ? 'NAIVE-TIERED' : "NAIVE (merge top-K' per minute)";
  console.log(`  rank  ${'CORRECT (sum, rank)'.padEnd(width + 14)}  ${naiveLabel}`);
  for (let i = 0; i < Math.max(correctTop.length, naiveTop.length); i++) {
    const c = correctTop[i] ? `${correctTop[i].item_id.padEnd(width)} ${String(correctTop[i].total).padStart(8)}` : '';
    const n = naiveTop[i] ? `${naiveTop[i].item_id.padEnd(width)} ${String(naiveTop[i].total).padStart(8)}` : '(fewer than k survived)';
    console.log(`  ${String(i + 1).padStart(3)}   ${c.padEnd(width + 14)}  ${n}`);
  }

  console.log('\n----- diff (CORRECT top-k vs NAIVE) -----');
  const missing = correctTop.filter((r) => !naiveByItem.has(r.item_id));
  if (missing.length) {
    for (const r of missing) {
      console.log(`  MISSING FROM NAIVE: ${r.item_id}  correct_total=${r.total}  naive_total=${naiveByItem.get(r.item_id) ?? 0} (never survived a per-minute cut)`);
    }
  } else {
    console.log('  no keys missing — every CORRECT top-k key also appears in NAIVE.');
  }
  const falselyPromoted = naiveTop.filter((r) => correctTop.findIndex((c) => c.item_id === r.item_id) === -1);
  if (falselyPromoted.length) {
    for (const r of falselyPromoted) {
      console.log(`  FALSELY PROMOTED BY NAIVE: ${r.item_id}  naive_total=${r.total}  correct_total=${correctByItem.get(r.item_id) ?? 0} (correct rank outside top-${k})`);
    }
  }
  const inversions = correctTop
    .map((r, ci) => ({ item: r.item_id, ci, ni: naiveTop.findIndex((n) => n.item_id === r.item_id) }))
    .filter((x) => x.ni !== -1 && x.ni !== x.ci);
  for (const x of inversions) console.log(`  RANK INVERSION: ${x.item}  correct_rank=${x.ci + 1}  naive_rank=${x.ni + 1}`);

  if (dupRows.length) {
    console.log(`\n  ⚠ rows>1 detected for ${dupRows.length}+ (window,item) pairs — sink wrote a window more than once. First: ${JSON.stringify(dupRows[0])}`);
  }
  console.log('');
  process.exit(0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      out[key] = (i + 1 < argv.length && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    }
  }
  return out;
}
