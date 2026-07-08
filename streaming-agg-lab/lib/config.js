// Shared config for the three Node scripts. Env vars override everything.
module.exports = {
  brokers: (process.env.KAFKA_BROKERS || 'localhost:29092').split(','),
  inputTopic: process.env.INPUT_TOPIC || 'events',
  outputTopic: process.env.OUTPUT_TOPIC || 'agg-results',
  clickhouse: {
    url: process.env.CLICKHOUSE_URL || 'http://localhost:8123',
    username: process.env.CLICKHOUSE_USER || 'lab',
    password: process.env.CLICKHOUSE_PASSWORD || 'lab',
    database: process.env.CLICKHOUSE_DB || 'lab',
  },
  // MUST match the Flink TUMBLE size in flink/aggregate.sql, or the
  // producer's ground-truth window math won't line up with ClickHouse.
  windowMs: 10000,
  eventTypes: ['page_view', 'add_to_cart', 'purchase', 'search'],
};
