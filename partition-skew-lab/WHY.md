# Why: partition skew & the consumer-scaling ceiling

Observable claim: partition skew sets a ceiling consumer scaling cannot break
through. An uneven key distribution creates a hot partition, and since a
consumer group never assigns more than one consumer per partition, that
partition's single consumer bounds throughput — no matter how many consumers
or partitions you add — unless the key distribution itself changes.

## Failure matrix

| # | Scenario | Prediction | Observed | Verdict | Takeaway |
|---|----------|-----------|----------|---------|----------|
| 1 | Baseline: uniform keys, 4 consumers / 4 partitions | (steady-state check, not scored) | Lag stayed 0-3, ~45-58 msg/s per partition | — | Confirms harness capacity model before any scenario runs |
| 2 | Skew introduced: skewed keys (90% on `hot`), 4 consumers / 4 partitions | Hot partition's lag grows, other 3 stay near 0; consumer plateaus at 100 msg/s; incoming ~190/s; lag grows ~90/s | Hot partition (2) lag grew continuously (555→2247 over 14s), other 3 stayed ~0. Consumer-3 (assigned partition 2) held a steady ~98/s the whole run — right at the ceiling. Incoming rate (from `high-water`, not the noisy commit-derived column) was ~175/s. True net lag growth ≈ 175-98 = ~77/s. | ✓ | Mechanism and magnitude both close. **Instrumentation gotcha**: kafkajs autocommits at batch boundaries, not smoothly — the monitor's `committed`/`msgs/sec` columns are bursty and misleading for short-window rate reads. The consumer's own per-message counter (incremented right where `work-ms` is simulated) is the reliable instrument; `high-water` is reliable for incoming rate since it's independent of consumer commit timing. |

| 3 | Over-provision under skew: same skewed load, add a 5th consumer to the already-4-member group mid-run | 5th consumer gets no partition (idle); hot partition's lag-growth rate unchanged; no reshuffle among the existing 4 | 5th consumer: `assigned partitions: []`, processed 0 the whole run — confirmed idle. Hot partition growth rate: confirmed unchanged (consumer-3 held steady ~98/s before and after). Reshuffle: a full stop-the-world rebalance DID fire — all 4 existing consumers got `"group is rebalancing, rejoin needed"` and had to rejoin — it just happened to reassign everyone back to their original partition. Rebalance cost landed unevenly: consumer-3 (hot partition, also group leader) rejoined in 25ms; cold-partition consumers took up to 2.5s. Measured impact on the hot partition specifically: ~7-message dip, not the ~300 a naive "everyone pauses equally" estimate would predict. | ◑ | Adding a consumer that ends up idle is NOT free — the coordinator can't know the outcome in advance, so it forces every existing member through a rejoin to find out. But rebalance cost isn't evenly distributed: it lands hardest on whichever members take longest to rejoin, which in this case were the already-underloaded cold partitions, not the one that mattered. |

| 4 | Control: uniform keys, scale consumers 1→2→3→4→5 | 1 consumer: lag grows ~100/s (200 in − 100 capacity). Improves at every step up to 4. At 4: flattens to ~0-2 like baseline. 5th: idle, no lasting effect. | Whichever partition lacked a dedicated consumer kept lagging (one partition's lag climbed into the 1000s while waiting); it collapsed sharply the moment a consumer was assigned to it, not gradually. At 4 consumers: back to baseline shape, lag 0-3, ~45-55 msg/s/partition. 5th consumer: same rejoin-for-everyone pattern as S3, no lasting effect since no backlog remained to protect. | ✓ | Scaling "helps" as a step function per partition, not a smooth aggregate curve — each new consumer only relieves the specific partition it gets assigned to. This isolates the pure ceiling mechanism from skew: the ceiling is exactly the partition count, full stop, independent of key distribution. |

| 5 | The trap: grow topic 4→8 partitions mid-run, skewed load unchanged | Group stays locked to old 4 partitions until restart; `hot` key stays on same partition; skew growth rate unchanged | Monitor/admin saw 8 partitions immediately (admin client isn't subject to consumer-side caching); the *consumer group* didn't rebalance onto them within the observed window. Source check (`kafkajs/src/consumer/consumerGroup.js:448-449`, `src/index.js:24`): consumer only re-checks partition metadata when its cache expires, and `metadataMaxAge` defaults to 300,000ms (5 min) — not a hard restart requirement, just a long default TTL. Restarting forced an immediate fresh subscribe, which picked up all 8 partitions right away (round-robin gave each of 4 consumers 2 partitions). `hot` stayed on partition 2 both before and after growth; partitions 4-7 carried zero traffic (all 4 keys' hashes happened to still land in 0-3). Growth rate held steady post-restart because partition 2 was paired with silent partition 4 — a lucky assignor outcome, not a guarantee. | ◑ | Growing partitions doesn't reshuffle already-hashed keys and doesn't fix skew — confirmed. But "requires a restart" overstates it: it's a bounded metadata-cache TTL (5 min default), not a hard block. Also: post-growth rebalance can make things *worse* if the assignor happens to pair the hot partition with another loaded one on the same consumer — this run got lucky. |

| 6a | The fix, attempt 1: salt `hot` into 8 sub-keys (`--salt 8`), 4 partitions/4 consumers | Load spreads evenly across all 4 partitions, ~50/s each, lag ~0-2 like baseline | Salting confirmed working (8 distinct `hot-0`..`hot-7` keys observed in producer log) — but partition mapping was 6/8 buckets → partition 2, 2/8 → partition 0, 0/8 → partitions 1 and 3. Partition 2 lagged just as badly as the unsalted case (~11k+ and climbing). | ✗ | Salting only works if bucket count is high enough for the hash to average out. With just 8 buckets over 4 partitions, an uneven collision (6/2/0/0) is well within normal hash variance, not a bug. Diagnosed correctly using the producer's own key→partition log — the right instrument, since monitor/consumer logs alone couldn't explain *why* it failed. |

| 6b | The fix, attempt 2: same salted `hot` key, `--salt 50` instead of 8, 4 partitions/4 consumers | Distribution flattens across all 4 partitions, near-zero lag everywhere | Lag stayed 0-6 across all 4 partitions the entire run. Throughput settled unevenly but safely: partition 2 ~70-80/s, partition 0 ~64-73/s, partition 1 ~35-44/s, partition 3 ~15-20/s — none approached the ~100/s per-consumer ceiling. | ✓ | The fix isn't "make every partition identical" — it's "keep every partition under its consumer's capacity ceiling." 50 buckets was enough for the hash to average out; 8 wasn't. Salting is a numbers game against the partition count, not a guarantee at any bucket count. |

## The answer

Partition skew sets a ceiling consumer scaling cannot break through, full stop — the ceiling is the partition count, and it doesn't move no matter how many consumers you throw at it (S4). A hot key doesn't get diluted by adding consumers (S3) or by adding partitions (S5, since Kafka's default partitioner routes by `hash(key) % partition_count` and never moves already-hashed traffic). The only lever that actually works is changing what the key *is* — and even that isn't automatic: salting into too few buckets can recreate the same skew one level down (S6a), because you're now depending on a hash function to average out over a small sample. The fix is real, but it's a numbers game against your partition count (S6b), not a guarantee.

Reproducible in an interview, three sentences: *"Consumer groups can never assign more than one consumer per partition, so a hot partition's single consumer is always the throughput ceiling — more consumers or more partitions don't help because Kafka's partitioner never re-routes already-hashed traffic. The only fix is salting the hot key into enough sub-keys that the hash function actually averages out across your partition count; too few buckets just relocates the skew instead of removing it. And because a rebalance is triggered by any membership change regardless of outcome, even a doomed-to-be-idle consumer joining costs the whole group a brief stop-the-world pause."*

## Prediction scorecard

6 scored scenarios: **3 correct, 2 partial, 1 wrong.**

- ✓ S2 (skew mechanism + magnitude)
- ◑ S3 (idle consumer + growth rate right; missed that a rebalance fires anyway even when the outcome doesn't change)
- ✓ S4 (control: pure ceiling mechanism, scaling helps up to partition count)
- ◑ S5 (hot key doesn't move + skew not fixed by growth, right; "requires restart" overstated — real mechanism is a bounded 5-min metadata cache)
- ✗ S6a (predicted salting fixes it; 8 buckets over 4 partitions collided 6/2/0/0 by hash chance — naive expectation falsified)
- ✓ S6b (corrected: 50 buckets was enough to flatten it)

Pattern in the misses: both were about **mechanism completeness, not direction** — the outcome he predicted (idle consumer, no fix from growth) was right, but the *reason* had a gap (rebalances aren't outcome-gated; metadata caching isn't a hard restart requirement). Different flavor from the storage-layout lab's misses (which were about magnitude/ranking); this time the gaps were in "what else is happening underneath the observed number."

## Parking lot

- kafkajs's default autoCommit-at-batch-boundary behavior makes offset-derived
  throughput metrics unreliable at short time windows — a real production
  gotcha for anyone building lag dashboards off committed offsets alone. The
  consumer's own per-message counter (or `high-water` for incoming rate) is
  the reliable instrument; committed-offset deltas are not.
- kafkajs's default `metadataMaxAge` (300,000ms / 5 min) means a running
  consumer group does NOT immediately notice a topic's partition count grew —
  not a hard restart requirement, just a long default cache TTL. Worth
  knowing for anyone who grows partitions in production expecting instant
  rebalancing.
