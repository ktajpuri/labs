# WHY — Redis Pub/Sub Delivery Semantics (why Redis Streams exist)

**Concept internalized:** Redis Pub/Sub is *fire-and-forget* — a published message
is delivered only to subscribers connected at the instant of `PUBLISH`, with no
storage, no replay, no delivery guarantee (**at-most-once**). Redis **Streams**
exist to add the one thing Pub/Sub lacks: a **durable log consumers read by
position**, turning delivery into **at-least-once with replay**.

Mode: DISCOVERY. Date: 2026-07-19.

---

## The observable claim (naive world)

> A producer publishes messages; a consumer that is absent, joins late, or blips
> off the network receives fewer than were published, and the missing ones are
> gone forever — no error, no retry, no trace.

Every scenario below made a **number** visible: the publisher's `delivered_to=N`
(receiver count that `PUBLISH` returns) and the subscriber's sequence-gap list.

---

## Failure matrix (naive Pub/Sub → fixed Streams)

| # | Scenario | Naive Pub/Sub observed | Diagnosis (2a) | Fixed (Streams) predicted → observed | Verdict |
|---|----------|------------------------|----------------|--------------------------------------|---------|
| 1 | Publish into empty room, consume later | `delivered_to=0` ×10; late subscriber gets **0**, forever | "no storage; clients can't request past messages; redis is a proxy — stores connections not messages" | 10 received, gaps none → **10, none** | 2a ✓ / 2b ✓ |
| 2 | Late joiner (subscribe mid-stream) | `first seq seen = 16`; lost 1–15 (boundary = subscribe time) | "gets the message sent right after connect; no gaps after join — normal subscriber" | first=1, all 20, gaps none → **first=1, 20, none** | 2a ✓ / 2b ✓ |
| 3 | Transient blip on an *established* subscriber | `gaps: 6, 7, 8` **permanent** (2s outage) | (predicted) "1–5, gap, 10–20; missed msgs nuked, redis doesn't store them" | no gaps, 0 dups → **20, 0 dups, none** | 2a ✓ (count ±1 timing) / 2b ✓ |
| 4 | Two consumers, same room/group (control) | both subs get **all 10** (broadcast), `avg 2.00` | (predicted) both get all — fan-out, not a queue | shared group **splits**: ~10 each, total 20, no overlap → **c1 evens / c2 odds** | 2a ✓ / 2b ✓ |
| 5 | **Boundary:** crash-before-ack → reclaim | — | — | seq 3 stranded pending; reclaim reprocesses → **at-least-once duplicate** (batch stranded 3,4,5) | 2b partial |

### The naive-vs-fixed pairs (interview-reproducible)

- **Empty room:** without durability the late consumer got **0**; with a durable
  log it recovers **all 10**. (The log persists independent of who's listening.)
- **Late join:** Pub/Sub loss boundary = *your subscribe timestamp* (`first=16`);
  Streams loss boundary = *the group's position* (created at `0` → `first=1`).
  Connect time stops mattering.
- **Blip:** an established Pub/Sub subscriber loses everything published during the
  outage (`gaps 6,7,8`); a Streams consumer finds those entries still in the log,
  undelivered to its group, and `XREADGROUP >` replays them on reconnect (`none`).
- **Fan-out:** two Pub/Sub subscribers each get everything (broadcast); two
  consumers in **one** Streams group **split** the work (competing consumers).

---

## What you should be able to reproduce cold (3 sentences)

1. Redis Pub/Sub is a **stateless broadcast router**: on `PUBLISH` it writes the
   message to every currently-subscribed socket and then discards it — the
   message's entire lifetime is the duration of the `PUBLISH` call, so any
   subscriber not connected at that instant loses it with no way to recover
   (**at-most-once, no durability, no replay**).
2. Redis Streams fix this by appending each message to a **durable append-only log**
   (`XADD`) keyed by a monotonic ID; consumers read **by position** via a consumer
   group (`XREADGROUP ... >`), so an absent / late / reconnecting consumer picks up
   exactly what it hasn't consumed — the group's stored position is the durable
   pointer Pub/Sub never had.
3. A single consumer **group** is **competing-consumers load-balancing** (each
   message to exactly one member), NOT broadcast — to get Pub/Sub-style fan-out
   *with* durability you give **each consumer its own group**.

## The boundary — what Streams do NOT solve

Streams give **at-least-once**, not exactly-once. If a consumer crashes after
processing a message but before `XACK`, the entry stays in the group's **Pending
Entries List (PEL)** and is **redelivered** on recovery (`XREADGROUP ... 0` /
`XAUTOCLAIM`) → a **duplicate side effect** (e.g. a double charge). Worse, because
`XREADGROUP COUNT n` moves an entire **batch** into the PEL at fetch time,
"delivered" means *assigned to a consumer*, not *processed* — a crash can strand
several unprocessed entries that all get reclaimed. The **only** fix is an
**idempotent consumer** (idempotency key), which lives outside Redis's guarantee —
identical in shape to the durable-execution boundary from the Temporal lab.

## Design decision table (the answer to "how is Redis used in pub/sub?")

| You want | Use |
|----------|-----|
| Fan-out, loss acceptable (presence, live cursors, cache invalidation) | **Pub/Sub** |
| Fan-out **+** durability/replay (every instance gets every message) | **Streams, one consumer group per consumer** |
| Split work across N workers, durably, with acks/retries | **Streams, one shared consumer group** |

In a multi-instance WebSocket deployment, Pub/Sub is the classic **cross-instance
fan-out bus** (a message on instance A reaches clients on instance B). The
persistence + latecomer catch-up you get from a WebSocket app's DB + init/history
payload is app-layer work Pub/Sub does not do — Streams is the Redis-native way to
get it.

---

## Scorecards

- **Diagnosis accuracy (2a):** 4 / 4.
- **Prediction accuracy (2b):** 4 / 4 core scenarios ✓; boundary (S5) **partial** —
  correctly predicted the duplicate + idempotency fix, missed that batch `COUNT`
  prefetch strands multiple entries in the PEL (delivered ≠ processed).

The 2b result (concept landed) is strong: every core prediction correct, and the
one imperfection was on a mechanism subtlety (batch delivery into the PEL), not on
the concept itself.

## Parking lot (seeds for future labs, NOT chased here)

- **Stream retention / `MAXLEN` trimming:** the log is durable but not infinite —
  `XADD ... MAXLEN ~ N` trims old entries; a consumer slower than the trim rate can
  still lose messages. (Config-boundary lab of its own.)
- **`XAUTOCLAIM` / dead consumer recovery:** how pending entries from a permanently
  dead consumer get reassigned to a live one, and the `min-idle-time` threshold.
- **Sharded Pub/Sub (`SPUBLISH`/`SSUBSCRIBE`)** in Redis Cluster — how fan-out
  behaves across shards.
- **Idempotency-key implementation** for the consumer (dedupe store + TTL) — the
  concrete form of the boundary fix.
