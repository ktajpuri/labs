// Producer: emits events with a selectable key strategy so we can control
// whether load lands evenly across partitions or piles onto one hot key.
//
// Usage:
//   node producer/produce.js --keys uniform --rate 200               # even load (high-cardinality keys)
//   node producer/produce.js --keys skewed --rate 200                # ~90% of traffic on one key ('hot')
//   node producer/produce.js --keys salted --rate 200 --salt 8       # 'hot' fanned out into 8 sub-keys
//
const { Kafka } = require('kafkajs');
const { randomUUID, randomInt } = require('crypto');
const cfg = require('../lib/config');

const args = parseArgs(process.argv.slice(2));
const rate = Number(args.rate || 200);            // events/sec
const durationS = args.duration ? Number(args.duration) : null;
const keyStrategy = args.keys || 'uniform';        // uniform | skewed | salted
const saltBuckets = Number(args.salt || 8);
const hotFraction = Number(args['hot-fraction'] || 0.9);
const otherKeys = ['k2', 'k3', 'k4'];

const kafka = new Kafka({ clientId: `producer-${keyStrategy}`, brokers: cfg.brokers });
const producer = kafka.producer();

let seq = 0;
let stopping = false;
const counts = new Map(); // key -> count sent, printed as ground truth on exit

function pickKey() {
  if (keyStrategy === 'uniform') return `u-${randomInt(0, 100000)}`;
  // skewed and salted both start from the same hot/cold split
  const isHot = Math.random() < hotFraction;
  const base = isHot ? 'hot' : otherKeys[randomInt(0, otherKeys.length)];
  if (keyStrategy === 'salted' && base === 'hot') return `hot-${randomInt(0, saltBuckets)}`;
  return base;
}

async function sendOne() {
  seq++;
  const key = pickKey();
  counts.set(key, (counts.get(key) || 0) + 1);
  const event = { event_id: randomUUID(), seq, sent_at: Date.now() };
  const [md] = await producer.send({
    topic: cfg.topic,
    messages: [{ key, value: JSON.stringify(event) }],
  });
  if (seq % 100 === 0) {
    console.log(`#${seq} key=${key.padEnd(10)} -> partition ${md.partition}`);
  }
}

function printSummary() {
  console.log(`\n===== SENT (key strategy: ${keyStrategy}) =====`);
  for (const [k, c] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(10)} ${c}`);
  }
  console.log(`  total: ${seq}`);
  console.log('================================================\n');
}

async function main() {
  await producer.connect();
  console.log(
    `producer -> ${cfg.brokers} topic=${cfg.topic} keys=${keyStrategy} rate=${rate}/s` +
    (keyStrategy !== 'uniform' ? `  [hot-fraction=${hotFraction}${keyStrategy === 'salted' ? ` salt=${saltBuckets}` : ''}]` : '')
  );
  const intervalMs = Math.max(1, Math.round(1000 / rate));
  const start = Date.now();

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    printSummary();
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
