// consume-stream.js  (THE FIX, consumer half)
// Reads a durable Redis Stream via a CONSUMER GROUP. The group remembers, per
// consumer, which entries have been delivered and which have been acknowledged,
// so a consumer that is absent / late / reconnecting picks up exactly what it
// hasn't consumed yet — the replay-by-position that Pub/Sub lacked.
//
// Key commands:
//   XGROUP CREATE key group <from> MKSTREAM  -- create the group; <from>=0 means
//                                               "start at the beginning of the log"
//   XREADGROUP GROUP g c COUNT n BLOCK ms STREAMS key >   -- new (never-delivered) entries
//   XREADGROUP GROUP g c ... STREAMS key 0                -- THIS consumer's pending (unacked) entries
//   XACK key group id                        -- mark an entry processed
//
// Usage:
//   node consume-stream.js [--stream=room:general:stream] [--group=cg1] [--consumer=c1]
//                          [--from=0] [--expect=N] [--block-ms=2000]
//                          [--crash-before-ack=SEQ]   simulate a crash: exit(1) after
//                                                      reading (NOT acking) that entry
//                          [--reclaim]                 on start, reprocess THIS consumer's
//                                                      pending (unacked) entries first
//                          [--blip-at=SEQ --blip-ms=MS] drop + reconnect this consumer's
//                                                      connection mid-stream (models a
//                                                      network outage in ONE process)
//
// Env: REDIS_URL (default redis://127.0.0.1:6380)

const Redis = require("ioredis");

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6380";
const stream = arg("stream", "room:general:stream");
const group = arg("group", "cg1");
const consumer = arg("consumer", "c1");
const from = arg("from", "0");
const expect = arg("expect", null) ? parseInt(arg("expect", "0"), 10) : null;
const blockMs = parseInt(arg("block-ms", "2000"), 10);
const crashBeforeAck = arg("crash-before-ack", null) ? parseInt(arg("crash-before-ack", "0"), 10) : null;
const reclaim = flag("reclaim");
const blipAt = arg("blip-at", null) ? parseInt(arg("blip-at", "0"), 10) : null;
const blipMs = parseInt(arg("blip-ms", "3000"), 10);
let blipped = false;

let redis = new Redis(REDIS_URL);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seen = new Set();
let received = 0;
let acked = 0;
let duplicates = 0;
let minSeq = Infinity;
let maxSeq = -Infinity;

function record(seq) {
  if (seen.has(seq)) duplicates++;
  seen.add(seq);
  received++;
  minSeq = Math.min(minSeq, seq);
  maxSeq = Math.max(maxSeq, seq);
}

async function handleEntries(entries, { isPending }) {
  for (const [id, fields] of entries) {
    // fields is a flat array [k, v, k, v, ...]; we stored one field "data"
    const dataIdx = fields.indexOf("data");
    const msg = JSON.parse(fields[dataIdx + 1]);
    record(msg.seq);
    process.stdout.write(
      `[consumer ${consumer}] got seq=${String(msg.seq).padStart(3, " ")} id=${id}` +
        `${isPending ? " (reclaimed pending)" : ""}  (received: ${received})\n`
    );

    if (crashBeforeAck !== null && msg.seq >= crashBeforeAck) {
      console.log(`\n[consumer ${consumer}] *** CRASH before ACK at seq=${msg.seq} (entry stays PENDING) ***`);
      process.exit(1);
    }

    await redis.xack(stream, group, id);
    acked++;
    if (expect !== null && received >= expect) finish("reached --expect count");

    if (blipAt !== null && !blipped && msg.seq >= blipAt) {
      blipped = true;
      console.log(`\n[consumer ${consumer}] *** BLIP: dropping connection at seq=${msg.seq}, back in ${blipMs}ms ***\n`);
      redis.disconnect();
      await sleep(blipMs);
      redis = new Redis(REDIS_URL);
      console.log(`[consumer ${consumer}] reconnected after blip — resuming XREADGROUP >\n`);
    }
  }
}

async function main() {
  console.log(`[consumer ${consumer}] stream=${stream} group=${group} from=${from} expect=${expect ?? "(until idle/Ctrl-C)"} reclaim=${reclaim}`);
  try {
    await redis.xgroup("CREATE", stream, group, from, "MKSTREAM");
    console.log(`[consumer ${consumer}] created group "${group}" starting at ${from}`);
  } catch (e) {
    if (String(e.message).includes("BUSYGROUP")) {
      console.log(`[consumer ${consumer}] group "${group}" already exists — resuming from its stored position`);
    } else throw e;
  }

  // Optionally reprocess this consumer's own pending (delivered-but-unacked) entries first.
  if (reclaim) {
    const pend = await redis.xreadgroup("GROUP", group, consumer, "COUNT", 1000, "STREAMS", stream, "0");
    if (pend) {
      for (const [, entries] of pend) await handleEntries(entries, { isPending: true });
    }
  }

  let idleRounds = 0;
  while (true) {
    const res = await redis.xreadgroup("GROUP", group, consumer, "COUNT", 10, "BLOCK", blockMs, "STREAMS", stream, ">");
    if (!res) {
      idleRounds++;
      if (idleRounds >= 2) return finish("idle (no new entries)");
      continue;
    }
    idleRounds = 0;
    for (const [, entries] of res) await handleEntries(entries, { isPending: false });
  }
}

function finish(why) {
  const missing = [];
  if (received > 0) for (let s = minSeq; s <= maxSeq; s++) if (!seen.has(s)) missing.push(s);
  console.log(`\n[consumer ${consumer}] ---- SUMMARY (${why}) ----`);
  console.log(`[consumer ${consumer}] received (incl. dups) : ${received}`);
  console.log(`[consumer ${consumer}] distinct seqs         : ${seen.size}`);
  console.log(`[consumer ${consumer}] duplicates            : ${duplicates}`);
  console.log(`[consumer ${consumer}] acked                 : ${acked}`);
  console.log(`[consumer ${consumer}] first / last seq      : ${received ? minSeq : "-"} / ${received ? maxSeq : "-"}`);
  console.log(`[consumer ${consumer}] gaps inside range     : ${missing.length ? missing.join(", ") : "none"}`);
  try { redis.disconnect(); } catch {}
  process.exit(0);
}

process.on("SIGINT", () => finish("Ctrl-C"));
main().catch((e) => { console.error(`[consumer ${consumer}] error:`, e); process.exit(1); });
