// subscribe-pubsub.js
// A "server instance" that joins a room (= SUBSCRIBEs to a Redis channel) and
// counts what it actually receives. It tracks sequence numbers so GAPS (messages
// that were published but never arrived here) are visible.
//
// Usage:
//   node subscribe-pubsub.js [--channel=room:general] [--expect=N]
//                            [--blip-at=SEQ --blip-ms=MS]
//
//   --expect=N       : print the summary and exit once N messages have arrived,
//                      OR after 3s of silence (whichever comes first). Without it,
//                      the subscriber runs until you press Ctrl-C.
//   --blip-at=SEQ    : when a message with seq >= SEQ first arrives, physically
//   --blip-ms=MS       drop this subscriber's Redis connection and reconnect MS
//                      later. Simulates a transient network blip on an ESTABLISHED
//                      subscriber. Redis buffers nothing during the gap.
//
// Env: REDIS_URL (default redis://127.0.0.1:6380)

const Redis = require("ioredis");

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6380";
const channel = arg("channel", "room:general");
const expect = arg("expect", null) ? parseInt(arg("expect", "0"), 10) : null;
const blipAt = arg("blip-at", null) ? parseInt(arg("blip-at", "0"), 10) : null;
const blipMs = parseInt(arg("blip-ms", "1500"), 10);

const seen = new Set();
let received = 0;
let minSeq = Infinity;
let maxSeq = -Infinity;
let blipped = false;
let idleTimer = null;

function connect(label) {
  const sub = new Redis(REDIS_URL);

  sub.on("ready", () => {
    console.log(`[subscriber] ${label} — subscribing to "${channel}" (t=${new Date().toISOString().slice(11, 23)})`);
    sub.subscribe(channel);
  });

  sub.on("message", (chan, raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    received++;
    seen.add(msg.seq);
    minSeq = Math.min(minSeq, msg.seq);
    maxSeq = Math.max(maxSeq, msg.seq);

    process.stdout.write(`[subscriber] got seq=${String(msg.seq).padStart(3, " ")}  (total received: ${received})\n`);

    // Transient blip: drop the connection mid-stream, reconnect shortly after.
    if (blipAt !== null && !blipped && msg.seq >= blipAt) {
      blipped = true;
      console.log(`\n[subscriber] *** BLIP: dropping connection at seq=${msg.seq}, back in ${blipMs}ms ***\n`);
      sub.disconnect();
      setTimeout(() => connect("reconnected after blip"), blipMs);
      return;
    }

    if (expect !== null) {
      if (received >= expect) return finish(sub, "reached --expect count");
      resetIdle(sub);
    }
  });

  sub.on("error", (e) => console.error(`[subscriber] redis error: ${e.message}`));
  return sub;
}

function resetIdle(sub) {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => finish(sub, "3s idle (no more messages arriving)"), 3000);
}

function finish(sub, why) {
  const missing = [];
  if (received > 0) {
    for (let s = minSeq; s <= maxSeq; s++) if (!seen.has(s)) missing.push(s);
  }
  console.log(`\n[subscriber] ---- SUMMARY (${why}) ----`);
  console.log(`[subscriber] messages received     : ${received}`);
  console.log(`[subscriber] first seq seen         : ${received ? minSeq : "-"}`);
  console.log(`[subscriber] last seq seen          : ${received ? maxSeq : "-"}`);
  console.log(`[subscriber] gaps inside that range : ${missing.length ? missing.join(", ") : "none"}`);
  try { sub.disconnect(); } catch {}
  process.exit(0);
}

console.log(`[subscriber] url=${REDIS_URL} expect=${expect ?? "(run until Ctrl-C)"} blip-at=${blipAt ?? "off"}`);
const first = connect("initial connect");

process.on("SIGINT", () => finish(first, "Ctrl-C"));
