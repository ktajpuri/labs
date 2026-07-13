// Shared config for the top-K lab's Node scripts. Mirrors lib/config.js but
// points at its own topics/table so the parent lab's data stays untouched.
module.exports = {
  brokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
  inputTopic: process.env.TOPK_INPUT_TOPIC || 'events2',
  outputTopic: process.env.TOPK_OUTPUT_TOPIC || 'minute-counts',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'lab',
    password: process.env.CLICKHOUSE_PASSWORD || 'lab',
    database: process.env.CLICKHOUSE_DB || 'lab',
  },
  // MUST match the Flink TUMBLE size in flink/topk-minute.sql.
  windowMs: 60000,
  // Reserved item_ids, filtered out of every ground-truth print and every
  // query. '_flush' pushes the watermark past the final window so it fires.
  // '_hb' is sent explicitly to every partition every minute so no partition
  // can go idle and stall the (per-partition-min) watermark — see the
  // heartbeat comment in producer/topk-produce.js.
  flushKey: '_flush',
  heartbeatKey: '_hb',
  eventsPartitions: 3, // MUST match `--partitions 3` used to create the events2 topic
};
