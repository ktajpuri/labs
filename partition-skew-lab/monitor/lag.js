// Lag monitor: polls committed offsets vs each partition's high-water mark
// for the lab's consumer group, prints a live per-partition table every 2s.
// This is the instrument the whole lab is read off of — watch THIS while
// scenarios run.
//
// Usage: node monitor/lag.js
//
const { Kafka } = require('kafkajs');
const cfg = require('../lib/config');

const kafka = new Kafka({ clientId: 'lag-monitor', brokers: cfg.brokers });
const admin = kafka.admin();

const prev = new Map(); // partition -> { offset, t }

async function poll() {
  const now = Date.now();
  const [topicOffsets, groupOffsetsByTopic] = await Promise.all([
    admin.fetchTopicOffsets(cfg.topic),
    admin.fetchOffsets({ groupId: cfg.groupId, topics: [cfg.topic] }),
  ]);

  const high = new Map(topicOffsets.map((o) => [o.partition, Number(o.offset)]));
  const partitions = (groupOffsetsByTopic[0]?.partitions || []).slice().sort((a, b) => a.partition - b.partition);

  console.log(`\n--- lag @ ${new Date(now).toISOString().slice(11, 19)} ---`);
  console.log('part      committed    high-water          lag   msgs/sec');
  for (const p of partitions) {
    const committed = Number(p.offset) < 0 ? 0 : Number(p.offset);
    const hw = high.get(p.partition) ?? 0;
    const lag = Math.max(0, hw - committed);
    const prevP = prev.get(p.partition);
    let rate = '-';
    if (prevP) {
      const dt = (now - prevP.t) / 1000;
      rate = ((committed - prevP.offset) / dt).toFixed(1);
    }
    prev.set(p.partition, { offset: committed, t: now });
    console.log(
      `${String(p.partition).padStart(4)}  ${String(committed).padStart(11)}  ${String(hw).padStart(11)}  ${String(lag).padStart(11)}  ${String(rate).padStart(9)}`
    );
  }
}

async function main() {
  await admin.connect();
  console.log(`watching group '${cfg.groupId}' on topic '${cfg.topic}' (Ctrl-C to stop)`);
  await poll().catch((e) => console.error('poll error (group may not exist yet):', e.message));
  const timer = setInterval(() => poll().catch((e) => console.error('poll error:', e.message)), 2000);
  process.on('SIGINT', async () => {
    clearInterval(timer);
    await admin.disconnect();
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
