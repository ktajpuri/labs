# RUNBOOK — Redis Pub/Sub → Streams (self-contained retrieval drill)

Rerun this lab without any chat history. Predict before each reveal.

## Prerequisites

- Docker running (or local `redis-server`), Node 18+.
- `cd redis-pubsub-lab && npm install`

## Start Redis (host port 6380)

```bash
docker compose up -d
# fallback: redis-server --port 6380 --save '' --appendonly no --daemonize yes
```

## Reset to clean state (run before EACH scenario)

```bash
redis-cli -p 6380 flushall
```

Everything below assumes two or three terminals in `redis-pubsub-lab/`.

---

## PART A — naive Pub/Sub (at-most-once). Diagnose what breaks.

### A1 — Publish into an empty room, consume later
```bash
# no subscriber running:
node publish-pubsub.js --count=10 --rate-ms=100
# then start a subscriber and let it sit ~4s, Ctrl-C:
node subscribe-pubsub.js
```
**STOP — write your prediction before scrolling** (what does the late subscriber receive?)
<details><summary>Reveal</summary>

Publisher: `delivered_to=0` ×10. Late subscriber: **received 0**, forever. On
`PUBLISH`, Redis writes the message to every currently-subscribed socket and
discards it — no store, no replay. At-most-once. Message lifetime = the `PUBLISH`
call.
</details>

### A2 — Late joiner (subscribe mid-stream)
```bash
# Terminal B:
node publish-pubsub.js --count=20 --rate-ms=500
# Terminal A, ~2-3s later:
node subscribe-pubsub.js --expect=20
```
**STOP — write your prediction** (first seq seen? gaps?)
<details><summary>Reveal</summary>

`delivered_to` flips `0→1` at the first message published after the subscribe
completes (e.g. `first seq seen = 16`, lost 1–15). No gaps inside the received
range — the boundary is the **subscribe timestamp**; loss is join-time, not random.
</details>

### A3 — Transient blip on an established subscriber
```bash
# Terminal A first (drops at seq 5 for 2s, auto-reconnects):
node subscribe-pubsub.js --expect=20 --blip-at=5 --blip-ms=2000
# Terminal B:
node publish-pubsub.js --count=20 --rate-ms=500
```
**STOP — write your prediction** (where is the gap?)
<details><summary>Reveal</summary>

`gaps: 6, 7, 8` (whatever was published during the ~2s outage) — **permanent**.
Publisher independently shows `delivered_to=0` on exactly those seqs. A healthy,
established subscriber still loses everything published while disconnected; Pub/Sub
has no re-sync.
</details>

### A4 — Two subscribers, same room (control)
```bash
# Terminal A and Terminal C (both before publishing):
node subscribe-pubsub.js --expect=10
node subscribe-pubsub.js --expect=10
# Terminal B:
node publish-pubsub.js --count=10 --rate-ms=300
```
**STOP — write your prediction** (does each get 10, or is it split 5/5?)
<details><summary>Reveal</summary>

**Both** get all 10; `delivered_to=2` per message; `avg 2.00`. Pub/Sub is a
**broadcast** bus (fan-out to every subscriber), NOT a work queue — it does not
load-balance.
</details>

---

## PART B — the fix: Redis Streams (at-least-once, replay). Predict.

`XADD` appends to a durable log; a consumer group reads by position with
`XREADGROUP > `, acks with `XACK`. **Reset with `flushall` before each.**

### B1 — Publish into empty room, consume later (fixes A1)
```bash
node publish-stream.js --count=10 --rate-ms=100
node consume-stream.js --group=cg1 --expect=10
```
**STOP — predict**
<details><summary>Reveal</summary>

**10 received, gaps none.** The log persisted the messages (XLEN=10) with no
consumer present; the group created at position `0` replays them all. (A1 gave 0.)
</details>

### B2 — Late joiner (fixes A2)
```bash
# Terminal B:
node publish-stream.js --count=20 --rate-ms=500
# Terminal A, ~3s late:
node consume-stream.js --group=cg1 --expect=20
```
**STOP — predict**
<details><summary>Reveal</summary>

`first seq seen = 1`, all 20, gaps none — even though it started late. The loss
boundary moved from *connect time* (A2) to the *group's position* (0).
</details>

### B3 — Transient blip (fixes A3)
```bash
# Terminal A first:
node consume-stream.js --group=cg1 --expect=20 --blip-at=5 --blip-ms=3000
# Terminal B:
node publish-stream.js --count=20 --rate-ms=500
```
**STOP — predict** (gaps? duplicates?)
<details><summary>Reveal</summary>

**20 received, 0 duplicates, gaps none.** Messages published during the 3s outage
stayed in the log undelivered to the group; `XREADGROUP >` delivered them on
reconnect. (0 dups here because ack precedes the drop.)
</details>

### B4 — Two consumers, same group (boundary vs A4)
```bash
# Terminal A and C (before publishing):
node consume-stream.js --group=cg1 --consumer=c1 --expect=20 --block-ms=2000
node consume-stream.js --group=cg1 --consumer=c2 --expect=20 --block-ms=2000
# Terminal B:
node publish-stream.js --count=20 --rate-ms=300
```
**STOP — predict** (each gets 20 like A4, or split?)
<details><summary>Reveal</summary>

**Split** — c1 gets evens, c2 gets odds, 10 each, total 20, no overlap. A single
consumer group is competing-consumers **load-balancing**, not broadcast. For
fan-out with durability, give **each consumer its own group**.
</details>

### B5 — Boundary: at-least-once (crash before ack)
```bash
node publish-stream.js --count=5 --rate-ms=0
node consume-stream.js --group=cg1 --consumer=c1 --crash-before-ack=3
node consume-stream.js --group=cg1 --consumer=c1 --reclaim --expect=5 --block-ms=1500
```
**STOP — predict** (which seq is processed twice? which sit stranded?)
<details><summary>Reveal</summary>

Run 1 processes/acks 1,2, reads 3 and crashes before ack. Because `XREADGROUP
COUNT 10` prefetched **1–5 in one batch**, seqs **3,4,5** are all in c1's Pending
Entries List (delivered ≠ processed). Run 2 `--reclaim` reprocesses all three:
**seq 3 runs a SECOND time** (at-least-once duplicate; a double charge if that's a
payment). The only safe fix is an **idempotent consumer** — Redis's guarantee is
at-least-once, exactly-once is on you.
</details>

---

## Teardown
```bash
docker compose down     # or: redis-cli -p 6380 shutdown nosave
```
