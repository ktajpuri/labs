// Sink-consumer: reads Flink's windowed results off Kafka 'agg-results'
// and inserts each row into ClickHouse. Consumer group = 'clickhouse-sink'.
//
// This is the component where "exactly-once" lives (Phase B): the offset it
// commits and whether it dedups decide whether a Flink restart double-counts.
// For now it does a plain insert — one message in, one row out.
//
const { Kafka } = require('kafkajs');
const { createClient } = require('@clickhouse/client');
const cfg = require('../lib/config');

const kafka = new Kafka({ clientId: 'sink', brokers: cfg.brokers });
const consumer = kafka.consumer({ groupId: 'clickhouse-sink' });
const ch = createClient(cfg.clickhouse);

// --dedupe makes the sink idempotent: it remembers every (window_start, event_type)
// it has already written and skips repeats. This is what turns Flink's at-least-once
// replay (after a checkpointed restart) into effectively exactly-once at the sink.
// NOTE: the memory here is in-process — a real sink would dedupe in a durable store.
const dedupe = process.argv.includes('--dedupe');
const seen = new Set();

let inserted = 0;
let skipped = 0;

async function main() {
  await consumer.connect();
  await consumer.subscribe({ topic: cfg.outputTopic, fromBeginning: false });
  console.log(`sink: kafka '${cfg.outputTopic}' -> ${cfg.clickhouse.url} db=${cfg.clickhouse.database} table=aggregates` + (dedupe ? '  [DEDUPE ON]' : ''));
  await consumer.run({
    eachMessage: async ({ partition, message }) => {
      const row = JSON.parse(message.value.toString());
      const key = `${row.window_start}|${row.event_type}`;
      if (dedupe && seen.has(key)) {
        skipped++;
        console.log(`[p${partition} off=${message.offset}] DUP SKIPPED window=${row.window_start} ${row.event_type}  (skipped: ${skipped})`);
        return;
      }
      await ch.insert({
        table: 'aggregates',
        values: [{
          window_start: row.window_start,
          window_end: row.window_end,
          event_type: row.event_type,
          cnt: row.cnt,
          sum_value: row.sum_value,
        }],
        format: 'JSONEachRow',
      });
      if (dedupe) seen.add(key);
      inserted++;
      console.log(
        `[p${partition} off=${message.offset}] window=${row.window_start} ` +
        `${String(row.event_type).padEnd(11)} cnt=${String(row.cnt).padStart(3)} ` +
        `sum=${row.sum_value}   (inserted this run: ${inserted})`
      );
    },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
process.on('SIGINT', async () => { try { await consumer.disconnect(); } finally { process.exit(0); } });
