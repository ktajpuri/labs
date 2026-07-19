// publish-pubsub.js
// A "server instance" broadcasting messages into a room (= a Redis channel).
//
// Key instrument: the integer that PUBLISH returns is the number of subscriber
// connections that received THIS message at THIS instant. We print it per message
// and sum it, so you can literally watch fan-out (and loss) happen.
//
// Usage:
//   node publish-pubsub.js [--count=100] [--rate-ms=100] [--channel=room:general]
//
// Env: REDIS_URL (default redis://127.0.0.1:6380)

const Redis = require("ioredis");

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : def;
}

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6380";
const channel = arg("channel", "room:general");
const count = parseInt(arg("count", "100"), 10);
const rateMs = parseInt(arg("rate-ms", "100"), 10);

const redis = new Redis(REDIS_URL);

(async () => {
  console.log(
    `[publisher] channel=${channel} count=${count} rate=${rateMs}ms url=${REDIS_URL}`
  );
  console.log(`[publisher] each line shows how many subscribers received that message\n`);

  let totalDeliveries = 0;
  let msgsWithZeroReceivers = 0;

  for (let seq = 1; seq <= count; seq++) {
    const body = JSON.stringify({ seq, ts: Date.now() });
    // PUBLISH returns the number of clients that received the message.
    const receivers = await redis.publish(channel, body);
    totalDeliveries += receivers;
    if (receivers === 0) msgsWithZeroReceivers++;

    process.stdout.write(
      `[publisher] seq=${String(seq).padStart(3, " ")}  delivered_to=${receivers}` +
        (receivers === 0 ? "   <-- received by NOBODY\n" : "\n")
    );

    if (rateMs > 0 && seq < count) {
      await new Promise((r) => setTimeout(r, rateMs));
    }
  }

  console.log(`\n[publisher] ---- SUMMARY ----`);
  console.log(`[publisher] messages published     : ${count}`);
  console.log(`[publisher] total deliveries        : ${totalDeliveries}  (sum of per-message receiver counts)`);
  console.log(`[publisher] messages received by 0  : ${msgsWithZeroReceivers}`);
  console.log(`[publisher] avg receivers / message : ${(totalDeliveries / count).toFixed(2)}`);

  await redis.quit();
})().catch((e) => {
  console.error("[publisher] error:", e);
  process.exit(1);
});
