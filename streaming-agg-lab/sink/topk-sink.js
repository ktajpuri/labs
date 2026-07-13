// Top-K lab sink-consumer: reads Flink's per-minute counts off Kafka
// 'minute-counts' and inserts each row into ClickHouse lab.minute_counts.
// Consumer group = 'topk-sink'. Plain insert, no dedupe — the table is a
// plain MergeTree (appends only), so a duplicate insert is SEEable as
// rows>1 in query/topk.js, same visibility principle as the parent lab.
//
const { Kafka } = require('kafkajs');
const { createClient } = require('@clickhouse/client');
const cfg = require('../lib/topk-config');

const kafka = new Kafka({ clientId: 'topk-sink', brokers: cfg.brokers });
const consumer = kafka.consumer({ groupId: 'topk-sink' });
const ch = createClient(cfg.clickhouse);

let inserted = 0;

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.outputTopic, fromBeginning: false });
  console.log(`topk-sink: kafka '${cfg.outputTopic}' -> ${cfg.clickhouse.url} db=${cfg.clickhouse.database} table=minute_counts`);
  await consumer.run({
    eachBatchAutoResolve: true,
    eachBatch: async ({ batch }) => {
      const rows = batch.messages
        .map((m) => JSON.parse(m.value.toString()))
        .filter((row) => row.item_id !== cfg.flushKey && row.item_id !== cfg.heartbeatKey)
        .map((row) => ({
          window_start: row.window_start,
          window_end: row.window_end,
          item_id: row.item_id,
          cnt: row.cnt,
        }));
      if (rows.length === 0) return;
      await ch.insert({ table: 'minute_counts', values: rows, format: 'JSONEachRow' });
      inserted += rows.length;
      console.log(`[batch] inserted ${rows.length} rows (total this run: ${inserted})  latest window_start=${rows[rows.length - 1].window_start}`);
    },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
process.on('SIGINT', async () => { try { await consumer.disconnect(); } finally { process.exit(0); } });
