// blast.js — high-throughput producer to induce BACKPRESSURE.
// Sends large batches to the 'events' topic as fast as possible and reports
// throughput. Used to make the producer outrun Flink so consumer lag grows.
//
//   node producer/blast.js --batch 1000
//
// Not for correctness (no ground-truth here) — the point is to overwhelm the
// consumer and watch lag + staleness, not to count exactly.
//
const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');
const cfg = require('../lib/config');

const args = parseArgs(process.argv.slice(2));
const batch = Number(args.batch || 1000);

const kafka = new Kafka({ clientId: 'blast', brokers: cfg.brokers });
const producer = kafka.producer();
const isoNoZone = (ms) => new Date(ms).toISOString().slice(0, 23);

let total = 0, lastTotal = 0, lastReport = Date.now(), stopping = false;

async function main() {
  await producer.connect();
  console.log(`BLAST: batches of ${batch} to '${cfg.inputTopic}' as fast as possible. Ctrl-C to stop.\n`);
  const report = setInterval(() => {
    const now = Date.now(), dt = (now - lastReport) / 1000;
    console.log(`  sent ${total} total  |  ${Math.round((total - lastTotal) / dt)}/s`);
    lastReport = now; lastTotal = total;
  }, 1000);

  while (!stopping) {
    const now = Date.now();
    const messages = [];
    for (let i = 0; i < batch; i++) {
      const type = cfg.eventTypes[Math.floor(Math.random() * cfg.eventTypes.length)];
      messages.push({
        key: type,
        value: JSON.stringify({
          event_id: randomUUID(),
          event_type: type,
          value: Math.round(Math.random() * 10000) / 100,
          event_time: isoNoZone(now),
        }),
      });
    }
    await producer.send({ topic: cfg.inputTopic, messages });
    total += batch;
  }
  clearInterval(report);
  console.log(`\nstopped. total sent: ${total}`);
  await producer.disconnect();
  process.exit(0);
}

process.on('SIGINT', () => { stopping = true; });
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
