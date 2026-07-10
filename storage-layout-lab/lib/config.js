const DEFAULT_ROWS = 20_000_000;
const EVENT_TYPES = ["click", "view", "purchase", "signup", "error", "refund"];
const USER_CARDINALITY = 2_000_000; // distinct user_ids to draw from
const PAYLOAD_BYTES = 96;

module.exports = {
  DEFAULT_ROWS,
  EVENT_TYPES,
  USER_CARDINALITY,
  PAYLOAD_BYTES,
  DATA_FILE: `${__dirname}/../data/events.ndjson`,
  META_FILE: `${__dirname}/../data/meta.json`,

  postgres: {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    user: "lab",
    password: "lab",
    database: "lab",
  },
  clickhouse: {
    url: process.env.CH_URL || "http://localhost:8123",
    username: "lab",
    password: "lab",
    database: "lab",
    // dataset ts values are ISO-8601 with a trailing "Z" (shared verbatim
    // across all three engines) — best_effort is what makes CH's strict
    // DateTime64 JSON parser accept that format.
    clickhouse_settings: { date_time_input_format: "best_effort" },
  },
  cassandra: {
    contactPoints: [process.env.CASS_HOST || "127.0.0.1"],
    localDataCenter: "dc1",
    keyspace: "lab",
  },
};
