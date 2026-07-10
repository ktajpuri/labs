// Same logical row shape everywhere: id, user_id, event_type, ts, amount, payload.
// `id` is the primary/partition key in all three engines on purpose — scenario 1
// and scenario 6 compare each engine's fastest lookup path on the SAME key, and
// scenario 4 relies on user_id being a non-key column everywhere.

const postgres = {
  drop: `DROP TABLE IF EXISTS events;`,
  create: `
    CREATE TABLE events (
      id BIGINT PRIMARY KEY,
      user_id INT NOT NULL,
      event_type TEXT NOT NULL,
      ts TIMESTAMPTZ NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      payload TEXT
    );
  `,
  createUserIdIndex: `CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);`,
  dropUserIdIndex: `DROP INDEX IF EXISTS idx_events_user_id;`,
  count: `SELECT count(*)::bigint AS n FROM events;`,
};

const clickhouse = {
  drop: `DROP TABLE IF EXISTS events;`,
  create: `
    CREATE TABLE events (
      id UInt64,
      user_id UInt32,
      event_type LowCardinality(String),
      ts DateTime64(3),
      amount Decimal(12,2),
      payload String
    ) ENGINE = MergeTree
    ORDER BY id;
  `,
  count: `SELECT count() AS n FROM events;`,
};

const cassandra = {
  createKeyspace: `
    CREATE KEYSPACE IF NOT EXISTS lab
    WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
  `,
  drop: `DROP TABLE IF EXISTS lab.events;`,
  create: `
    CREATE TABLE lab.events (
      id bigint PRIMARY KEY,
      user_id int,
      event_type text,
      ts timestamp,
      amount decimal,
      payload text
    );
  `,
};

module.exports = { postgres, clickhouse, cassandra };
