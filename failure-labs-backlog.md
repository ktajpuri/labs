# Failure Labs — Backlog

One lab = one concept, phrased as an observable claim. Check off when the failure matrix + why-doc are done. Run via `failure lab: <name>`.

## Data / Replication

- [ ] **Kafka ISR shrink & lost acks** — A write acked with `acks=all` can still be lost when `min.insync.replicas=1` and the leader dies. Observe the ack-vs-durability gap by flipping the config boundary.
- [ ] **Replication lag & stale reads** — A read replica serves data older than a write the client just confirmed. Observe read-your-writes violation under async replication and measure the lag window.
- [ ] **Split brain with naive failover** — Two nodes both accept writes after a partition, then diverge irreconcilably. Observe why fencing/epochs exist.
- [ ] **Quorum reads/writes (R+W>N)** — Show exactly when R+W>N guarantees the latest value and when sloppy quorums silently break it.

## Caching

- [ ] **Cache stampede** — Expire one hot key and watch N concurrent requests hammer the DB simultaneously. Then observe the fix (lock / stale-while-revalidate) collapsing N to 1.
- [ ] **Cache inconsistency: write-through vs invalidate** — Interleave a write and a read to produce a stale cache entry that never heals. Observe why "delete then write DB" ordering matters.
- [ ] **Hot key / skewed shard** — One key gets 90% of traffic; watch one cache node saturate while others idle. Observe local caching / key-splitting fix.

## Queues / Async

- [ ] **Idempotent consumers & at-least-once delivery** — Kill a consumer mid-batch and watch the same message processed twice; observe duplicate side effects, then the idempotency-key fix.
- [ ] **Poison pill & DLQ** — One malformed message blocks a partition forever. Observe consumer lag climbing, then the dead-letter fix.
- [ ] **Backpressure vs unbounded queue** — Producer outpaces consumer; watch memory/lag grow without bound, then observe bounded-queue rejection behavior.

## Resilience patterns

- [ ] **Retry storm amplification** — A slow dependency plus naive retries turns 1x load into 3–4x, taking down a healthy service. Observe jitter + budget fix.
- [ ] **Circuit breaker states** — Watch closed→open→half-open transitions under injected failure, and the recovery probe behavior.
- [ ] **Timeout mismatch cascade** — Caller timeout shorter than callee's; watch work completing after the caller gave up (wasted work + retry duplicates).
- [ ] **Thundering herd on service restart** — All clients reconnect at once after a blip; observe connection-storm failure vs jittered reconnect.

## Consistency / Coordination

- [ ] **Consistent hashing vs mod-N** — Add one node; observe ~1/N keys move with consistent hashing vs nearly all with mod-N. Include virtual-node distribution.
- [ ] **Distributed lock with expiry** — A lock holder pauses (GC/sleep) past the lease; watch two holders act concurrently. Observe why fencing tokens are needed.
- [ ] **Clock skew & LWW data loss** — Two writers with skewed clocks; last-write-wins silently drops the newer write. Observe the loss counter.

## Frontend

- [ ] **Stale response race (out-of-order fetches)** — Fire two searches; the slower first request resolves last and overwrites the newer result. Observe the bug, then AbortController / request-versioning fix.
- [ ] **Event loop blocking** — A 200ms synchronous loop freezes clicks, animation, and rendering. Observe long-task timing, then chunking / `requestIdleCallback` / worker offload.
- [ ] **Memory leak from listeners/closures** — Mount/unmount a component 1000× without cleanup; watch heap grow in a snapshot diff, then the cleanup fix flatten it.
- [ ] **Layout thrashing** — Interleave style reads and writes in a loop; observe forced synchronous reflows in the profiler vs batched read-then-write.
- [ ] **Optimistic UI rollback** — Apply an update locally, fail the server call, and observe state divergence when rollback is missing vs correct reconciliation.
- [ ] **Debounce vs throttle under burst input** — Type rapidly against a live-search endpoint; count requests fired under none / debounce / throttle and observe the latency-vs-load trade.
- [ ] **Service worker stale cache** — Deploy a new version; observe users stuck on the old bundle with cache-first strategy, then stale-while-revalidate + skipWaiting behavior.
- [ ] **CORS preflight** — Trigger an OPTIONS preflight by adding one header; observe when the browser sends it, caches it, and blocks the response despite a 200 from the server.

## Delivery / Edge

- [ ] **Webhook reliability** — Receiver flaps; observe missed, duplicated, and out-of-order deliveries, then the signed + idempotent + retry-with-backoff receiver.
- [ ] **Rate limiter boundary burst** — Fixed-window limiter admits 2x the limit at a window boundary; observe sliding-window/token-bucket comparison.
