// Admin helper: create (delete+recreate) or grow the lab topic's partition count.
//
// Usage:
//   node scripts/topic.js create --partitions 4   # delete-if-exists, then create fresh
//   node scripts/topic.js grow --partitions 8      # increase partitions on the EXISTING topic (no delete)
//   node scripts/topic.js describe
//
// Kafka topics can only GROW their partition count, never shrink — 'grow'
// exists as its own command (not folded into 'create') because scenario 5
// depends on growing WITHOUT deleting: existing messages don't move when
// you add partitions, only future produces are affected.
const { Kafka } = require('kafkajs');
const cfg = require('../lib/config');

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const partitions = Number(args.partitions || cfg.defaultPartitions);

const kafka = new Kafka({ clientId: 'topic-admin', brokers: cfg.brokers });
const admin = kafka.admin();

async function main() {
  await admin.connect();
  const existing = await admin.listTopics();

  if (cmd === 'create') {
    if (existing.includes(cfg.topic)) {
      console.log(`deleting existing topic '${cfg.topic}'...`);
      await admin.deleteTopics({ topics: [cfg.topic] });
      await sleep(2000); // give the controller time to fully remove it before recreating
    }
    await admin.createTopics({
      topics: [{ topic: cfg.topic, numPartitions: partitions, replicationFactor: 1 }],
    });
    console.log(`created '${cfg.topic}' with ${partitions} partitions`);
  } else if (cmd === 'grow') {
    if (!existing.includes(cfg.topic)) throw new Error(`topic '${cfg.topic}' doesn't exist — run 'create' first`);
    const meta = await admin.fetchTopicMetadata({ topics: [cfg.topic] });
    const current = meta.topics[0].partitions.length;
    if (partitions <= current) throw new Error(`partition count can only grow: currently ${current}, asked for ${partitions}`);
    await admin.createPartitions({ topicPartitions: [{ topic: cfg.topic, count: partitions }] });
    console.log(`grew '${cfg.topic}' from ${current} -> ${partitions} partitions (existing messages did NOT move)`);
  } else if (cmd === 'describe') {
    if (!existing.includes(cfg.topic)) throw new Error(`topic '${cfg.topic}' doesn't exist — run 'create' first`);
    const meta = await admin.fetchTopicMetadata({ topics: [cfg.topic] });
    console.log(JSON.stringify(meta.topics[0], null, 2));
  } else {
    console.error('usage: node scripts/topic.js <create|grow|describe> [--partitions N]');
    process.exit(1);
  }

  await admin.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
