// publish-stream.js  (THE FIX, producer half)
// Same "server broadcasting to a room", but instead of PUBLISH (fire-and-forget)
// it uses XADD to append each message to a durable Redis Stream (an append-only
// log). The message now PERSISTS as a real Redis key until trimmed.
//
// Contrast with publish-pubsub.js: XADD returns the assigned entry ID, NOT a
// receiver count. Delivery is decoupled from publish time entirely — nobody has
// to be listening for the message to survive.
//
// Usage:
//   node publish-stream.js [--count=100] [--rate-ms=100] [--stream=room:general:stream]
//
// Env: REDIS_URL (default redis://127.0.0.1:6380)

const Redis = require("ioredis");

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6380";
const stream = arg("stream", "room:general:stream");
const count = parseInt(arg("count", "100"), 10);
const rateMs = parseInt(arg("rate-ms", "100"), 10);

const redis = new Redis(REDIS_URL);

(async () => {
  console.log(`[producer] stream=${stream} count=${count} rate=${rateMs}ms url=${REDIS_URL}`);
  console.log(`[producer] XADD appends to a durable log — no subscriber needs to be present\n`);

  for (let seq = 1; seq <= count; seq++) {
    const id = await redis.xadd(stream, "*", "data", JSON.stringify({ seq, ts: Date.now() }));
    process.stdout.write(`[producer] seq=${String(seq).padStart(3, " ")}  stored id=${id}\n`);
    if (rateMs > 0 && seq < count) await new Promise((r) => setTimeout(r, rateMs));
  }

  const len = await redis.xlen(stream);
  console.log(`\n[producer] ---- SUMMARY ----`);
  console.log(`[producer] messages appended    : ${count}`);
  console.log(`[producer] stream length now     : ${len}  (they persist until trimmed/deleted)`);
  await redis.quit();
})().catch((e) => {
  console.error("[producer] error:", e);
  process.exit(1);
});
