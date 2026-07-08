// Producer: emits random events into Kafka 'events' and keeps a GROUND TRUTH
// count per (window, type) so you can compare "what I sent" vs "what ClickHouse shows".
//
// Usage:
//   node producer/produce.js --rate 5                 # 5 events/sec forever (Ctrl-C to stop)
//   node producer/produce.js --rate 5 --duration 30   # stop after 30s and print ground truth
//   node producer/produce.js --rate 5 --late-every 10 --late-ms 20000   # Phase B: late events
//
const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');
const cfg = require('../lib/config');

const args = parseArgs(process.argv.slice(2));
const rate = Number(args.rate || 5);                 // events/sec
const durationS = args.duration ? Number(args.duration) : null;
const lateMs = Number(args['late-ms'] || 0);         // Phase B: backdate amount
const lateEvery = Number(args['late-every'] || 0);   // Phase B: every Nth event is late (0 = off)

const kafka = new Kafka({ clientId: 'producer', brokers: cfg.brokers });
const producer = kafka.producer();

const truth = new Map(); // `${windowStart}|${type}` -> count
let seq = 0;
let stopping = false;

const windowStartMs = (ms) => Math.floor(ms / cfg.windowMs) * cfg.windowMs;
const isoNoZone = (ms) => new Date(ms).toISOString().slice(0, 23); // "2026-07-08T12:00:00.123"

function bump(ms, type) {
  const k = `${isoNoZone(windowStartMs(ms))}|${type}`;
  truth.set(k, (truth.get(k) || 0) + 1);
}

async function sendOne() {
  seq++;
  const type = cfg.eventTypes[Math.floor(Math.random() * cfg.eventTypes.length)];
  const now = Date.now();
  const isLate = lateEvery > 0 && seq % lateEvery === 0;
  const eventMs = isLate ? now - lateMs : now;
  const event = {
    event_id: randomUUID(),
    event_type: type,
    value: Math.round(Math.random() * 10000) / 100, // 0.00 .. 100.00
    event_time: isoNoZone(eventMs),
  };
  const [md] = await producer.send({
    topic: cfg.inputTopic,
    messages: [{ key: type, value: JSON.stringify(event) }],
  });
  bump(eventMs, type);
  console.log(
    `#${String(seq).padStart(4)} ${isLate ? 'LATE ' : '     '}` +
    `type=${type.padEnd(11)} value=${String(event.value).padStart(6)} ` +
    `event_time=${event.event_time} win=${isoNoZone(windowStartMs(eventMs))} ` +
    `p=${md.partition} off=${md.baseOffset}`
  );
}

function printTruth() {
  console.log('\n===== GROUND TRUTH (what the producer actually sent) =====');
  for (const [k, c] of [...truth.entries()].sort()) {
    const [win, type] = k.split('|');
    console.log(`  window=${win}  ${type.padEnd(11)} cnt=${c}`);
  }
  console.log(`  total events sent: ${seq}`);
  console.log('==========================================================\n');
}

async function main() {
  await producer.connect();
  console.log(
    `producer -> ${cfg.brokers} topic=${cfg.inputTopic} rate=${rate}/s` +
    (lateEvery ? `  [late: every ${lateEvery}th event backdated ${lateMs}ms]` : '')
  );
  const intervalMs = Math.max(1, Math.round(1000 / rate));
  const start = Date.now();

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    printTruth();
    await producer.disconnect();
    process.exit(0);
  }

  const timer = setInterval(async () => {
    if (stopping) return;
    try { await sendOne(); } catch (e) { console.error('send error:', e.message); }
    if (durationS && Date.now() - start >= durationS * 1000) shutdown();
  }, intervalMs);

  process.on('SIGINT', shutdown);
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
