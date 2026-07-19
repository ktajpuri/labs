# Redis Pub/Sub — Delivery Semantics Lab (DISCOVERY mode)

**Concept being internalized:** Redis Pub/Sub is *fire-and-forget*. A published
message is delivered only to subscribers connected **at that instant** — no
storage, no replay, no delivery guarantee. A subscriber that is offline, joins
late, or blips off the network simply loses those messages, silently.

**Mental-model bridge (from your WebSocket world):** Redis Pub/Sub is the
*cross-instance fan-out bus* — the thing that lets a message arriving at server
instance A reach a client connected to instance B. It gives you **only the
fan-out**. The persistence + latecomer catch-up you're used to (DB + init/history
sync) are things your app layer added on top; Pub/Sub does not do them.

This is the **naive** half of the lab. We prove where Pub/Sub bleeds messages
first; the fix (Redis Streams) comes after.

---

## Prerequisites

- Docker running (canonical), OR a local `redis-server` (fallback).
- Node.js (v18+).

## Setup

```bash
cd redis-pubsub-lab
npm install
```

## Start Redis (pick ONE)

**Canonical — Docker (listens on host port 6380):**
```bash
docker compose up -d
```

**Fallback — local redis-server on 6380 (if Docker is unavailable):**
```bash
redis-server --port 6380 --save '' --appendonly no --daemonize yes
```

Both expose Redis on **127.0.0.1:6380**. All scripts default to that.

## Reset to clean state

Pub/Sub holds no state, so "clean" just means a fresh Redis:
```bash
# Docker:
docker compose down && docker compose up -d
# Local:
redis-cli -p 6380 flushall
```

---

## Verify steady state (run this FIRST, before any scenario)

You need **two terminals**. Terminal A is a subscriber (server instance in the
room); Terminal B is the publisher (a server broadcasting to the room).

**Terminal A — start the subscriber first:**
```bash
node subscribe-pubsub.js --expect=5
```

**Terminal B — then publish 5 messages:**
```bash
node publish-pubsub.js --count=5 --rate-ms=200
```

Expected steady state:
- Publisher prints `delivered_to=1` for every message (one subscriber received it).
- Subscriber prints `got seq=1..5` and a summary: `received: 5`, `gaps: none`.

If you see that, the harness works. **Do not run scenarios until this passes.**

---

## What the instruments show you

- **Publisher** — `PUBLISH` returns the number of subscriber connections that
  received *that* message. We print it per message (`delivered_to=N`) and sum it.
  `delivered_to=0` means the message reached nobody and is now **gone**.
- **Subscriber** — counts messages and tracks sequence numbers, so a message that
  was published but never arrived here shows up as a **gap** in the summary.

## Script reference

```
node publish-pubsub.js   [--count=100] [--rate-ms=100] [--channel=room:general]
node subscribe-pubsub.js [--channel=room:general] [--expect=N]
                         [--blip-at=SEQ --blip-ms=MS]
```

---

## Part B — the fix (Redis Streams)

After you've watched Pub/Sub bleed messages, the fix is a durable log. `XADD`
appends each message to a Redis Stream; a **consumer group** reads by position
(`XREADGROUP ... >`) and acks (`XACK`), so absent / late / reconnecting consumers
recover exactly what they missed. **Reset with `redis-cli -p 6380 flushall`
before each stream scenario.**

```
node publish-stream.js   [--count=100] [--rate-ms=100] [--stream=room:general:stream]
node consume-stream.js   [--stream=room:general:stream] [--group=cg1] [--consumer=c1]
                         [--from=0] [--expect=N] [--block-ms=2000]
                         [--blip-at=SEQ --blip-ms=MS]        # network blip in one process
                         [--crash-before-ack=SEQ]           # at-least-once boundary demo
                         [--reclaim]                         # reprocess this consumer's pending
```

See **RUNBOOK.md** for the full predict-first scenario walkthrough (both halves)
and **WHY.md** for the failure matrix, the naive-vs-fixed pairs, and the
at-least-once boundary (idempotency).
