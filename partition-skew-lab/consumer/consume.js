// Consumer harness: spins up N independent consumer instances in ONE group.
// Each instance is a real group member — Kafka's own rebalance protocol
// decides which partitions it gets, not this script. Simulated per-message
// work (--work-ms) caps each instance's throughput, so a hot partition can
// outrun the single consumer responsible for it.
//
// Usage:
//   node consumer/consume.js --count 4 --work-ms 10
//
// To add MORE consumers to an already-running group without renaming
// collisions, offset the ids:
//   node consumer/consume.js --count 1 --work-ms 10 --id-offset 4   # becomes consumer-5
//
const { Kafka } = require('kafkajs');
const cfg = require('../lib/config');

const args = parseArgs(process.argv.slice(2));
const count = Number(args.count || 1);
const workMs = Number(args['work-ms'] || 10);
const idOffset = Number(args['id-offset'] || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function startOne(id) {
  const kafka = new Kafka({ clientId: `consumer-${id}`, brokers: cfg.brokers });
  const consumer = kafka.consumer({ groupId: cfg.groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.topic, fromBeginning: false });

  let assigned = [];
  let processedSinceLog = 0;

  consumer.on(consumer.events.GROUP_JOIN, (e) => {
    assigned = (e.payload.memberAssignment[cfg.topic] || []).slice().sort((a, b) => a - b);
    console.log(`[consumer-${id}] assigned partitions: [${assigned.join(', ')}]`);
  });

  const logTimer = setInterval(() => {
    console.log(`[consumer-${id}] processed ${processedSinceLog} msgs in last 5s  (partitions [${assigned.join(', ')}], capacity ~${Math.round(1000 / workMs)}/s)`);
    processedSinceLog = 0;
  }, 5000);

  await consumer.run({
    partitionsConsumedConcurrently: 1,
    eachMessage: async () => {
      await sleep(workMs);
      processedSinceLog++;
    },
  });

  return logTimer;
}

async function main() {
  console.log(`starting ${count} consumer(s) in group '${cfg.groupId}', work-ms=${workMs} (~${Math.round(1000 / workMs)} msg/s capacity each)`);
  for (let i = 1; i <= count; i++) {
    const id = idOffset + i;
    startOne(id).catch((e) => console.error(`[consumer-${id}] error:`, e.message));
  }
}

main();

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
