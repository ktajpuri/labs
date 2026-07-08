// inject-late.js — sends exactly N events timestamped in the PAST, all sharing
// one event_time so they all belong to a SINGLE already-closed window.
// Used to demonstrate what a streaming aggregator does with late data.
//
//   node producer/inject-late.js --count 10 --type page_view --age 25
//
//   --count  how many late events to send   (default 10)
//   --type   event_type to use              (default page_view)
//   --age    seconds in the PAST to backdate (default 25)
//   --value  value per event                (default 500)
//
const { Kafka } = require('kafkajs');
const { randomUUID } = require('crypto');
const cfg = require('../lib/config');

const args = parseArgs(process.argv.slice(2));
const count = Number(args.count || 10);
const type = args.type || 'page_view';
const ageS = Number(args.age || 25);
const value = Number(args.value || 500);

const kafka = new Kafka({ clientId: 'inject-late', brokers: cfg.brokers });
const producer = kafka.producer();

const windowStartMs = (ms) => Math.floor(ms / cfg.windowMs) * cfg.windowMs;
const isoNoZone = (ms) => new Date(ms).toISOString().slice(0, 23);

async function main() {
  await producer.connect();
  const eventMs = Date.now() - ageS * 1000; // every injected event uses this exact timestamp
  const win = isoNoZone(windowStartMs(eventMs));
  console.log(`\nInjecting ${count} '${type}' events with event_time=${isoNoZone(eventMs)} (${ageS}s in the past)`);
  console.log(`  -> all ${count} belong to window ${win}, which closed long ago.\n`);
  for (let i = 0; i < count; i++) {
    const event = { event_id: randomUUID(), event_type: type, value, event_time: isoNoZone(eventMs) };
    await producer.send({ topic: cfg.inputTopic, messages: [{ key: type, value: JSON.stringify(event) }] });
  }
  console.log(`Done. Sent ${count} late '${type}' events into window ${win}.`);
  console.log(`\nNOW CHECK ClickHouse for window ${win}, type ${type}:`);
  console.log(`  did its cnt go UP by ${count}, stay the same, or something else?\n`);
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
