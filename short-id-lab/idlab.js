#!/usr/bin/env node
// short-id-lab — one driver for all scenarios.
// Concepts made observable: sequential counter IDs, random base62 + collision
// check, Snowflake-style structured IDs — and where each one's uniqueness
// guarantee actually lives.
//
// Usage: node idlab.js <command> [flags]   (see README.md)

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { parseArgs } = require('node:util');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BASE = 62;
const DB_FILE = path.join(__dirname, 'ids.db');
const COUNTER_DB = path.join(__dirname, 'counter.db');

// ---------- base62 helpers ----------

function seqToId(n, len) {
  let s = '';
  let v = n;
  while (v > 0) { s = ALPHABET[v % BASE] + s; v = Math.floor(v / BASE); }
  return s.padStart(len, ALPHABET[0]);
}

function idToSeq(id) {
  let v = 0;
  for (const ch of id) v = v * BASE + ALPHABET.indexOf(ch);
  return v;
}

// Bulk random base62 chars via rejection sampling (bytes >= 248 rejected so
// b % 62 is exactly uniform).
class RandomIds {
  constructor() { this.buf = crypto.randomBytes(65536); this.i = 0; }
  nextChar() {
    for (;;) {
      if (this.i >= this.buf.length) { this.buf = crypto.randomBytes(65536); this.i = 0; }
      const b = this.buf[this.i++];
      if (b < 248) return ALPHABET[b % BASE];
    }
  }
  next(len) {
    let s = '';
    for (let k = 0; k < len; k++) s += this.nextChar();
    return s;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => n.toLocaleString('en-US');

// ---------- sequential ----------

function cmdSequential({ n, chars }) {
  const ids = new Array(n);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) ids[i] = seqToId(i, chars);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const unique = new Set(ids).size;

  console.log(`generated : ${fmt(n)} sequential ${chars}-char ids in ${ms.toFixed(0)} ms (${fmt(Math.round(n / (ms / 1000)))}/s)`);
  console.log(`unique    : ${fmt(unique)} / ${fmt(n)}  duplicates=${fmt(n - unique)}`);
  console.log(`first/last: ${ids[0]} .. ${ids[n - 1]}`);

  // Enumerability: an outsider holding one id predicts its neighbors.
  const k = Math.floor(n * 0.37);
  const guessNext = seqToId(idToSeq(ids[k]) + 1, chars);
  const guessPrev = seqToId(idToSeq(ids[k]) - 1, chars);
  console.log(`\nattacker view: sees only ${ids[k]}`);
  console.log(`  predicted next id : ${guessNext}  actual: ${ids[k + 1]}  match=${guessNext === ids[k + 1]}`);
  console.log(`  predicted prev id : ${guessPrev}  actual: ${ids[k - 1]}  match=${guessPrev === ids[k - 1]}`);
  console.log(`  ids issued so far derivable from one id: ${fmt(idToSeq(ids[k]) + 1)} (its own sequence number)`);
}

// ---------- sequential-multi (worker threads) ----------

function workerMain() {
  const { job, n, chars, dbFile } = workerData;
  if (job === 'seq-local') {
    const ids = new Array(n);
    for (let i = 0; i < n; i++) ids[i] = seqToId(i, chars);
    parentPort.postMessage({ ids });
  } else if (job === 'seq-shared') {
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA busy_timeout = 10000');
    const stmt = db.prepare('UPDATE counter SET n = n + 1 WHERE id = 1 RETURNING n');
    const ids = new Array(n);
    for (let i = 0; i < n; i++) ids[i] = seqToId(stmt.get().n, chars);
    db.close();
    parentPort.postMessage({ ids });
  }
}

async function cmdSequentialMulti({ n, chars, workers, mode }) {
  if (mode === 'shared') {
    rmDb(COUNTER_DB);
    const db = new DatabaseSync(COUNTER_DB);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE counter (id INTEGER PRIMARY KEY CHECK (id = 1), n INTEGER)');
    db.exec('INSERT INTO counter VALUES (1, 0)');
    db.close();
  }
  const job = mode === 'shared' ? 'seq-shared' : 'seq-local';
  const t0 = process.hrtime.bigint();
  const results = await Promise.all(
    Array.from({ length: workers }, () =>
      new Promise((resolve, reject) => {
        const w = new Worker(__filename, { workerData: { job, n, chars, dbFile: COUNTER_DB } });
        w.once('message', resolve);
        w.once('error', reject);
      }),
    ),
  );
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const all = results.flatMap((r) => r.ids);
  const unique = new Set(all).size;
  console.log(`mode      : ${mode}  workers=${workers}  ids/worker=${fmt(n)}`);
  console.log(`generated : ${fmt(all.length)} ids in ${ms.toFixed(0)} ms (${fmt(Math.round(all.length / (ms / 1000)))}/s aggregate)`);
  console.log(`unique    : ${fmt(unique)} / ${fmt(all.length)}  duplicates=${fmt(all.length - unique)}`);
}

// ---------- birthday / collision counting ----------

function cmdBirthday({ chars, trials }) {
  const space = Math.pow(BASE, chars);
  console.log(`keyspace  : 62^${chars} = ${fmt(space)}`);
  for (let t = 1; t <= trials; t++) {
    const rng = new RandomIds();
    const seen = new Set();
    const t0 = process.hrtime.bigint();
    let n = 0;
    for (;;) {
      const id = rng.next(chars);
      n++;
      if (seen.has(id)) {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        console.log(`trial ${t}   : FIRST COLLISION at draw #${fmt(n)} (id=${id})  [${ms.toFixed(0)} ms]`);
        break;
      }
      seen.add(id);
    }
  }
}

function cmdCollCount({ chars, n }) {
  const rng = new RandomIds();
  const seen = new Set();
  let collisions = 0;
  for (let i = 0; i < n; i++) {
    const id = rng.next(chars);
    if (seen.has(id)) collisions++;
    else seen.add(id);
  }
  console.log(`drew ${fmt(n)} random ${chars}-char ids (keyspace 62^${chars} = ${fmt(Math.pow(BASE, chars))})`);
  console.log(`collisions: ${fmt(collisions)}`);
}

// ---------- check-insert (collision check under concurrency) ----------

function rmDb(file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}

async function cmdCheckInsert({ mode, n, chars, concurrency, latency }) {
  rmDb(DB_FILE);
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  db.exec(mode === 'unique'
    ? 'CREATE TABLE ids (id TEXT PRIMARY KEY)'
    : 'CREATE TABLE ids (id TEXT)');
  const checkStmt = db.prepare('SELECT 1 AS x FROM ids WHERE id = ?');
  const insertStmt = db.prepare('INSERT INTO ids VALUES (?)');
  const rng = new RandomIds();

  let inserted = 0;
  let regenOnCheck = 0;   // collision check said "taken", picked a new id
  let constraintRetries = 0; // UNIQUE constraint fired at insert time
  const stats = { maxAttempts: 0 };

  async function insertOne() {
    let attempts = 0;
    for (;;) {
      attempts++;
      const candidate = rng.next(chars);
      await sleep(latency);               // network round trip: the check
      const exists = checkStmt.get(candidate) !== undefined;
      if (exists) { regenOnCheck++; continue; }
      await sleep(latency);               // network round trip: the insert
      try {
        insertStmt.run(candidate);
      } catch (e) {
        if (String(e.message).includes('UNIQUE')) { constraintRetries++; continue; }
        throw e;
      }
      inserted++;
      stats.maxAttempts = Math.max(stats.maxAttempts, attempts);
      return;
    }
  }

  const t0 = process.hrtime.bigint();
  let next = 0;
  async function lane() { while (next < n) { next++; await insertOne(); } }
  await Promise.all(Array.from({ length: concurrency }, lane));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const dupRows = db.prepare('SELECT id, COUNT(*) AS c FROM ids GROUP BY id HAVING c > 1').all();
  const extra = dupRows.reduce((s, r) => s + r.c - 1, 0);
  const total = db.prepare('SELECT COUNT(*) AS c FROM ids').get().c;
  db.close();

  console.log(`mode      : ${mode}  chars=${chars} (keyspace ${fmt(Math.pow(BASE, chars))})  n=${fmt(n)}  concurrency=${concurrency}  simulated RTT=${latency} ms/call`);
  console.log(`elapsed   : ${ms.toFixed(0)} ms`);
  console.log(`rows      : ${fmt(total)}  (target ${fmt(n)})`);
  console.log(`check said taken → regenerated : ${fmt(regenOnCheck)}`);
  console.log(`UNIQUE constraint retries      : ${fmt(constraintRetries)}`);
  console.log(`DUPLICATE IDS ADMITTED         : ${fmt(dupRows.length)} distinct ids, ${fmt(extra)} extra rows`);
  if (dupRows.length) console.log(`  e.g. ${dupRows.slice(0, 5).map((r) => `${r.id}×${r.c}`).join('  ')}`);
}

// ---------- snowflake ----------

const EPOCH = Date.UTC(2026, 0, 1); // custom epoch: 2026-01-01T00:00:00Z

class Snowflake {
  constructor(workerId, { clock = Date.now, guard = false } = {}) {
    this.workerId = workerId;
    this.clock = clock;
    this.guard = guard;
    this.lastTs = -1;
    this.seq = 0;
    this.overflowWaits = 0;
    this.stalledMs = 0;
  }
  next() {
    let ts = this.clock();
    if (ts < this.lastTs) {
      if (this.guard) {
        const stall = this.lastTs - ts;
        this.stalledMs += stall;
        while ((ts = this.clock()) < this.lastTs) { /* wait for clock to catch up */ }
      }
      // no guard: fall through — ts is in the past, sequence resets below
    }
    if (ts === this.lastTs) {
      this.seq = (this.seq + 1) & 4095; // 12-bit sequence
      if (this.seq === 0) {
        this.overflowWaits++;
        while ((ts = this.clock()) <= this.lastTs) { /* sequence exhausted: wait for next ms */ }
      }
    } else {
      this.seq = 0;
    }
    this.lastTs = ts;
    return (BigInt(ts - EPOCH) << 22n) | (BigInt(this.workerId) << 12n) | BigInt(this.seq);
  }
}

function decode(id) {
  return {
    ts: new Date(Number(id >> 22n) + EPOCH).toISOString(),
    worker: Number((id >> 12n) & 1023n),
    seq: Number(id & 4095n),
  };
}

function cmdSnowflakeBurst({ n }) {
  const sf = new Snowflake(7);
  const ids = new Array(n);
  const perMs = new Map();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) {
    ids[i] = sf.next();
    const ms = Number(ids[i] >> 22n);
    perMs.set(ms, (perMs.get(ms) || 0) + 1);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const counts = [...perMs.values()];
  const unique = new Set(ids.map(String)).size;
  let sorted = true;
  for (let i = 1; i < n; i++) if (ids[i] <= ids[i - 1]) { sorted = false; break; }

  console.log(`generated : ${fmt(n)} ids in ${ms.toFixed(1)} ms (${fmt(Math.round(n / (ms / 1000)))}/s)`);
  console.log(`unique    : ${fmt(unique)} / ${fmt(n)}   strictly-increasing=${sorted}`);
  console.log(`ms buckets: ${counts.length}  ids/ms max=${fmt(Math.max(...counts))} min=${fmt(Math.min(...counts))}`);
  console.log(`sequence-exhausted waits (spins to next ms): ${fmt(sf.overflowWaits)}`);
  console.log(`decode first: ${JSON.stringify(decode(ids[0]))}`);
  console.log(`decode last : ${JSON.stringify(decode(ids[n - 1]))}`);
}

async function cmdSnowflakeRollback({ rollback, mode }) {
  let offset = 0;
  const sf = new Snowflake(7, { clock: () => Date.now() + offset, guard: mode === 'guard' });
  const seen = new Set();
  let dups = 0;
  let firstDup = null;
  let generated = 0;
  const runMs = 400;
  const batch = 50; // ids per ~1 ms tick → sequence stays low within each ms
  const t0 = Date.now();
  let rolledBack = false;

  while (Date.now() - t0 < runMs) {
    if (!rolledBack && Date.now() - t0 >= runMs / 2) {
      offset = -rollback;
      rolledBack = true;
      console.log(`t=+${Date.now() - t0} ms: CLOCK ROLLED BACK ${rollback} ms (offset now ${offset})`);
    }
    for (let i = 0; i < batch; i++) {
      const id = sf.next();
      generated++;
      const key = String(id);
      if (seen.has(key)) { dups++; if (!firstDup) firstDup = id; }
      else seen.add(key);
    }
    await sleep(1);
  }
  console.log(`mode      : ${mode}  rollback=${rollback} ms  generated=${fmt(generated)}`);
  console.log(`DUPLICATE IDS ISSUED: ${fmt(dups)}`);
  if (firstDup) console.log(`  first duplicate: ${firstDup} → ${JSON.stringify(decode(firstDup))}`);
  console.log(`generator stalled waiting for clock: ${fmt(sf.stalledMs)} ms`);
}

// ---------- main ----------

const COMMANDS = {
  sequential: { fn: cmdSequential, defaults: { n: 100000, chars: 7 } },
  'sequential-multi': { fn: cmdSequentialMulti, defaults: { n: 5000, chars: 7, workers: 4, mode: 'local' } },
  birthday: { fn: cmdBirthday, defaults: { chars: 5, trials: 1 } },
  collcount: { fn: cmdCollCount, defaults: { chars: 7, n: 100000 } },
  'check-insert': { fn: cmdCheckInsert, defaults: { mode: 'read-then-insert', n: 2000, chars: 2, concurrency: 50, latency: 5 } },
  'snowflake-burst': { fn: cmdSnowflakeBurst, defaults: { n: 50000 } },
  'snowflake-rollback': { fn: cmdSnowflakeRollback, defaults: { rollback: 100, mode: 'naive' } },
  reset: {
    fn: () => { rmDb(DB_FILE); rmDb(COUNTER_DB); console.log('removed ids.db and counter.db (incl. -wal/-shm) — clean state'); },
    defaults: {},
  },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const entry = COMMANDS[cmd];
  if (!entry) {
    console.log(`commands: ${Object.keys(COMMANDS).join(', ')}`);
    process.exit(cmd ? 1 : 0);
  }
  const { values } = parseArgs({
    args: rest,
    options: Object.fromEntries(Object.keys(entry.defaults).map((k) => [k, { type: 'string' }])),
  });
  const opts = { ...entry.defaults };
  for (const [k, v] of Object.entries(values)) {
    opts[k] = typeof entry.defaults[k] === 'number' ? Number(v) : v;
  }
  await entry.fn(opts);
}

if (isMainThread) {
  main().catch((e) => { console.error(e); process.exit(1); });
} else {
  workerMain();
}
