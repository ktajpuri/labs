// inject-dup.js — deterministically tests the sink's idempotency.
// It reads an EXISTING window_start string straight from ClickHouse (verbatim,
// no format guessing) and re-emits that exact (window, type) onto 'agg-results'
// with a cnt=999 sentinel — a byte-identical duplicate of a window the sink has
// already written.
//
//   node producer/inject-dup.js --type page_view
//
// A normal sink INSERTS it -> that (window,type) becomes rows=2, cnt jumps to 999.
// A --dedupe sink recognizes the key and prints "DUP SKIPPED" (ClickHouse untouched).
//
const { Kafka } = require('kafkajs');
const { createClient } = require('@clickhouse/client');
const cfg = require('../lib/config');

const args = parseArgs(process.argv.slice(2));
const type = args.type || 'page_view';

const kafka = new Kafka({ clientId: 'inject-dup', brokers: cfg.brokers });
const producer = kafka.producer();
const ch = createClient(cfg.clickhouse);

async function main() {
  // grab a recent, settled window that the sink has definitely already written
  const rs = await ch.query({
    query: `SELECT window_start, window_end FROM aggregates WHERE event_type = '${type}' ORDER BY window_start DESC LIMIT 1 OFFSET 3`,
    format: 'JSONEachRow',
  });
  const rows = await rs.json();
  if (!rows.length) { console.error('no existing rows to duplicate — is the pipeline running?'); process.exit(1); }
  const { window_start, window_end } = rows[0];

  await producer.connect();
  const msg = { window_start, window_end, event_type: type, cnt: 999, sum_value: 99999 };
  await producer.send({ topic: cfg.outputTopic, messages: [{ value: JSON.stringify(msg) }] });
  console.log(`\nSent a byte-identical DUPLICATE agg-result to '${cfg.outputTopic}':`);
  console.log(`  window_start=${window_start}  event_type=${type}  cnt=999 (sentinel)\n`);
  console.log(`Watch the sink terminal:`);
  console.log(`  - NORMAL sink   -> inserts it: window ${window_start} ${type} becomes rows=2, cnt=999`);
  console.log(`  - --dedupe sink -> prints "DUP SKIPPED" and ClickHouse is untouched\n`);
  await producer.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

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
