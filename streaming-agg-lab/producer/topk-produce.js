// Top-K lab producer: fabricates a compressed synthetic timeline (many
// "synthetic minutes" sent back-to-back in real time, timestamped a real
// 60s apart in event_time) so a synthetic day of 1-minute Flink windows
// fires in a few real minutes. Prints GROUND TRUTH (per-item totals) on
// exit so every scenario is checkable without trusting the pipeline.
//
// Usage:
//   node producer/topk-produce.js --scenario zipf    --minutes 5     # steady-state check
//   node producer/topk-produce.js --scenario zipf    --minutes 60    # S1 control
//   node producer/topk-produce.js --scenario sleeper --minutes 60    # S2 (+ S3 reuses this data)
//   node producer/topk-produce.js --scenario burst   --minutes 1440  # S4
//   node producer/topk-produce.js --scenario retain  --minutes 60 --sleeper-rank 25   # optional S3 demo
//
const { Kafka } = require('kafkajs');
const cfg = require('../lib/topk-config');

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario;
const minutes = Number(args.minutes || 60);
const rate = Number(args.rate || 2000);              // zipf only: target total events/minute
const sleeperRank = Number(args['sleeper-rank'] || 11); // retain only: where 'sleeper' ranks every minute

const SCENARIOS = ['zipf', 'sleeper', 'burst', 'retain'];
if (!SCENARIOS.includes(scenario)) {
  console.error(`--scenario must be one of: ${SCENARIOS.join(', ')}`);
  process.exit(1);
}

const kafka = new Kafka({ clientId: 'topk-producer', brokers: cfg.brokers });
const producer = kafka.producer();

const isoNoZone = (ms) => new Date(ms).toISOString().slice(0, 23);

// 10 decoys ranked 1..(R-1) with counts 100..(102-R), then 'sleeper' at
// count (101-R) — always exactly one count-step below the last decoy, so
// 'sleeper' lands at rank R in every minute, by construction. R=11 is the
// canonical recipe (10 decoys, sleeper at rank 11, count 90).
function decoyAndSleeperMinute(minute, R) {
  const m = new Map();
  for (let i = 1; i < R; i++) m.set(`decoy-${minute}-${i}`, 101 - i);
  m.set('sleeper', 101 - R);
  return m;
}

// Deterministic zipf(s) weights over `numKeys`, scaled so counts sum ~= rateTotal.
// Same distribution every minute — this is the "stable ranking" control.
function zipfCounts(numKeys, rateTotal, s) {
  const weights = [];
  let wsum = 0;
  for (let i = 1; i <= numKeys; i++) { const w = 1 / Math.pow(i, s); weights.push(w); wsum += w; }
  return weights.map((w) => Math.max(1, Math.round((w / wsum) * rateTotal)));
}

let zipfMap = null;
function zipfMinute() {
  if (!zipfMap) {
    const counts = zipfCounts(50, rate, 1.1);
    zipfMap = new Map(counts.map((c, i) => [`key-${String(i + 1).padStart(2, '0')}`, c]));
  }
  return new Map(zipfMap);
}

const burstMinute = Math.floor(minutes / 2);

function minuteItems(minute) {
  if (scenario === 'zipf') return zipfMinute();
  if (scenario === 'sleeper') return decoyAndSleeperMinute(minute, 11);
  if (scenario === 'retain') return decoyAndSleeperMinute(minute, sleeperRank);
  if (scenario === 'burst') {
    const m = decoyAndSleeperMinute(minute, 11);
    if (minute === burstMinute) m.set('burst', 3000);
    return m;
  }
}

const truth = new Map();       // item_id -> total count across the whole run
const perMinuteTop = [];       // [{minute, top: [[item,count],...]}]
let totalSent = 0;

async function sendMinute(minute, baseMs) {
  const items = minuteItems(minute);
  const messages = [];
  let idx = 0;
  for (const [item, count] of items) {
    truth.set(item, (truth.get(item) || 0) + count);
    const eventTime = isoNoZone(baseMs + minute * cfg.windowMs + (idx * 97) % (cfg.windowMs - 1000));
    for (let i = 0; i < count; i++) {
      messages.push({ key: item, value: JSON.stringify({ item_id: item, event_time: eventTime }) });
    }
    idx++;
  }
  // Heartbeat: one message sent to EVERY partition explicitly (bypassing the
  // key hash), timestamped near the end of this minute. Without this, an
  // item's key-hash can leave a partition with no new message for several
  // minutes; Flink's watermark is the MIN across partitions, so that one
  // quiet partition stalls the watermark and no window ever fires — the
  // exact idle-partition trap documented in the parent lab's aggregate.sql,
  // observed here even with 'table.exec.source.idle-timeout' set. Guaranteeing
  // forward progress on every partition every minute sidesteps it entirely.
  const hbTime = isoNoZone(baseMs + minute * cfg.windowMs + (cfg.windowMs - 500));
  for (let p = 0; p < cfg.eventsPartitions; p++) {
    messages.push({ partition: p, key: cfg.heartbeatKey, value: JSON.stringify({ item_id: cfg.heartbeatKey, event_time: hbTime }) });
  }
  perMinuteTop.push({
    minute,
    top: [...items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  });
  // kafkajs batches this as one produce request; fine up to a few thousand messages.
  await producer.send({ topic: cfg.inputTopic, messages });
  totalSent += messages.length;
}

function printTruth() {
  console.log('\n===== GROUND TRUTH (per-item totals across the whole run) =====');
  const sorted = [...truth.entries()].sort((a, b) => b[1] - a[1]);
  sorted.slice(0, 20).forEach(([item, c], i) => {
    console.log(`  #${String(i + 1).padStart(2)}  ${item.padEnd(16)} total=${c}`);
  });
  if (sorted.length > 20) console.log(`  ... (${sorted.length - 20} more items)`);
  console.log(`  total events sent: ${totalSent}  (minutes: ${minutes}, scenario: ${scenario})`);

  console.log('\n----- per-minute top-12 (sample) -----');
  const sample = perMinuteTop.length <= 10
    ? perMinuteTop
    : [...perMinuteTop.slice(0, 3), null, ...perMinuteTop.slice(-3)];
  for (const entry of sample) {
    if (entry === null) { console.log(`  ... (${perMinuteTop.length - 6} minutes omitted) ...`); continue; }
    const list = entry.top.map(([item, c]) => `${item}=${c}`).join(', ');
    console.log(`  minute ${entry.minute}: ${list}`);
  }
  console.log('=================================================================\n');
}

// Fixed, scenario-specific anchor for the synthetic timeline — NOT Date.now().
// Flink's TUMBLE windows are anchored to the real Unix epoch, so if two runs'
// synthetic-minute ranges were both derived from "now" they could land in the
// SAME window_start bucket (a run spans up to 1440 synthetic minutes = a full
// day of epoch-time even though it's sent in seconds of real time, so any two
// runs started within that span collide and their data gets silently mixed).
// Anchoring each scenario 10 days apart (comfortably more than the largest
// scenario's 1-day span) makes every run's window boundaries deterministic
// and collision-free, including reruns of the same scenario after a truncate.
const REFERENCE_MS = Date.UTC(2020, 0, 1);
const SCENARIO_EPOCH_OFFSET_DAYS = { zipf: 0, sleeper: 10, burst: 20, retain: 30 };

async function main() {
  await producer.connect();
  console.log(`topk-producer -> ${cfg.brokers} topic=${cfg.inputTopic} scenario=${scenario} minutes=${minutes}` +
    (scenario === 'zipf' ? ` rate=${rate}/min` : '') +
    (scenario === 'retain' ? ` sleeper-rank=${sleeperRank}` : ''));

  const baseMs = REFERENCE_MS + SCENARIO_EPOCH_OFFSET_DAYS[scenario] * 86400000;
  for (let minute = 0; minute < minutes; minute++) {
    await sendMinute(minute, baseMs);
    if (minute % Math.max(1, Math.floor(minutes / 20)) === 0 || minute === minutes - 1) {
      console.log(`  minute ${minute + 1}/${minutes}  (events sent so far: ${totalSent})`);
    }
  }

  // Flush event: pushes the watermark past the final window so it actually
  // fires. Sent to every partition explicitly — same reasoning as the
  // per-minute heartbeat above.
  const flushEventTime = isoNoZone(baseMs + minutes * cfg.windowMs + 5000);
  const flushMessages = [];
  for (let p = 0; p < cfg.eventsPartitions; p++) {
    flushMessages.push({ partition: p, key: cfg.flushKey, value: JSON.stringify({ item_id: cfg.flushKey, event_time: flushEventTime }) });
  }
  await producer.send({ topic: cfg.inputTopic, messages: flushMessages });
  console.log(`  sent flush event @ ${flushEventTime} to close the final window`);

  await producer.disconnect();
  printTruth();
  console.log('Wait ~10s for Flink to fire the final window and the sink to insert it, then run: npm run topk:query -- --window 1h\n');
  process.exit(0);
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
