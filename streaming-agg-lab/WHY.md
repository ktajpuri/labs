# Why — Streaming Aggregation Failure Modes

**The question this lab answers:** *Can I trust a streaming aggregate — and what
exactly makes it wrong vs right?*

**Observable claim:** events flow Kafka → Flink SQL (tumbling event-time window
count) → Kafka → ClickHouse. In the happy path the OLAP count equals what was
produced, one row per (window, type). Phase B breaks that on purpose.

---

## Failure matrix

Predictions are recorded **verbatim** as stated before each run — the gap between
the raw prediction and reality is the learning record.

| # | Scenario | Prediction (verbatim) | Observed | Verdict | Takeaway |
|---|----------|-----------------------|----------|---------|----------|
| 1 | Inject 10 events timestamped 25s in the past (into an already-fired window) while the pipeline runs | "It shows C. Late arrived events ignored. It ignores them. (where visible: not sure)" | Window count held at C — events NOT counted. `numLateRecordsDropped` rose **+1 per 10-event burst** (not +10). So: dropped & silently lost from the OLAP store; the drop metric *under-reports* the loss. | ✓ correct (outcome) | An event whose `event_time` falls in a window the watermark already closed is **dropped, not counted** — invisible in ClickHouse. The *only* trace is Flink's `numLateRecordsDropped`, and even that lies about magnitude (counts dropped **partials**, not raw events, due to local pre-aggregation). |
| 2 | Same 25s-late injection, but watermark delay changed 2s → 30s (config boundary flip) | "They get counted this time, the count for that window in OLAP updates. Cost: Flink keeps 30s of data in memory instead of 10s as a previous-window event might arrive and change the results → more memory." | Injected window `07:23:20` page_view cnt **29**, sum **8688** (10 sentinels @777 counted). `rows` still **1** (emitted once, final — NOT updated). Window became queryable **~30s after it ended** vs ~2s before. | ◑ partial | The watermark delay is a **completeness ↔ latency dial**. Raising it 2s→30s makes 25s-late events count — but every window is now queryable 30s after it ends (dashboard 30s stale). Same input, one line changed, opposite result. **Correction to prediction:** the window isn't emitted-then-revised (rows=1); it's *withheld* until the watermark says complete, then emitted once. State is held to **delay publishing**, not to **change a published number**. Memory is a real 2nd-order cost; latency is the 1st-order one. |
| 3 | Checkpointing OFF. Cancel Flink mid-stream, wait ~15s (outage), resubmit (`latest-offset`). Producer keeps writing to Kafka throughout. | "There is a gap in ClickHouse data, roughly **one window** worth goes missing. That mid-flight window gets dropped, not reported. Not sure on the outage events — guess they never get picked from the topic." | **Gap of ~4 windows per restart** (ran it twice → two holes). First window after restart came back **partial** (total 25 vs ~60, only 3 of 4 event types). Outage events were durable in Kafka but skipped by `latest-offset`. | ✓ mechanism (magnitude 4× low) | Without checkpointing, a restart **loses all in-flight state and skips every event during the outage** — permanent under-count. The events are safe in Kafka; **Flink's *position* is not.** Loss scales linearly with **total downtime = detect + decide + redeploy**, which is always longer than the naive estimate. The partial boundary window is the `latest-offset` mid-window rejoin signature. |
| 4a | Checkpointing ON (10s) + auto-restart, non-idempotent sink. Kill the TaskManager. | "Gap is filled, no loss, we see all windows. We see duplicate rows, rows → 2. Checkpointing alone does NOT make counts exactly right — no loss, but double counts, because post-checkpoint events get reprocessed." | **No gap** (`08:14:00→08:17:10` continuous — source rewound to checkpoint, outage reprocessed). Window `08:15:30` **duplicated**: all 4 types `rows=2`, total 118 ≈ 2×59. Recovery visibly went RUNNING→RESTARTING→RUNNING. | ✓✓✓ fully correct | **Checkpointing = at-least-once, NOT exactly-once.** It rewinds the source and restores state (no loss), but any window that fired *between the last checkpoint and the crash* is recomputed and **re-emitted** on restore. A non-idempotent sink writes it twice → doubled count. Checkpointing protects Flink's state, not the sink. |
| 4b | Checkpointing ON + **idempotent (`--dedupe`) sink**. Then a *deterministic* byte-identical duplicate injected onto `agg-results` (replays were too timing-dependent to reproduce). | "Idempotent sink → no duplicates, rows stays 1; it skips the replay. And the in-memory `seen` set means a *sink* restart would re-duplicate." | Dedupe sink printed **`DUP SKIPPED window=08:41:00 page_view`**; ClickHouse untouched. Plain sink (4a contrast) inserts the same dup → `rows=2, cnt=999`. **Bonus bug:** the first injector formatted the timestamp `…30.000` vs Flink's `…30` — the mismatched key silently **defeated dedupe AND evaded `rows>1` detection** (a phantom `window_start` row remained, caught only by the `cnt=999` sentinel). | ✓ correct | Exactly-once at the OLAP store = **checkpointing (no loss) + idempotent sink (no dupes)**. Dedupe on a canonical `(window,type)` key turns Flink's at-least-once replay into effectively exactly-once. **But idempotency is only as good as its key:** a non-canonical key (timestamp `.000` formatting) silently breaks it *and* hides from naive duplicate checks. And an **in-memory** `seen` set is lost if the sink restarts → real systems need durable idempotency (upsert / `ReplacingMergeTree`) or a transactional 2-phase-commit sink. |
| 5 | Blast producer (batched, ~tens of thousands/s) >> Flink throughput. Watch consumer lag + freshness. | "Lag grows continuously, unbounded. Freshness falls behind, latest data processes late. Counts still correct, just late. Backpressure is a **freshness** failure — when events get processed the data is correct." | `flink-agg` LAG grew **unbounded** (partition 2 → ~2.6M; p0 loaded; **p1 stayed 0 — idle**). Freshness fell **~9 min** behind wall-clock. Counts huge but `rows=1` (no corruption). Stopping the blast → lag **drained to 0** and freshness recovered — **no loss.** | ✓✓✓ fully correct | Backpressure is a **freshness** failure, not correctness: events buffer durably in Kafka, event-time windows keep counts exact, results just publish late; lag & staleness grow under overload and recover when it subsides (loss only if Kafka retention < drain time). **His catch:** the lag was skewed onto ONE partition (`event_type` keying → p1 idle, p2 hot), so *adding consumers can't help* — throughput is capped by the hottest partition. |

---

## The answer — reproduce this cold

**Can I trust a streaming aggregate?** Only if you know its two failure axes and
have paid for both:

1. **Correctness under late data.** An event whose `event_time` falls in a window
   the watermark already closed is **dropped, not counted** — silently absent from
   the OLAP store (only Flink's drop metric hints at it, and it under-reports). The
   watermark delay is a **completeness ↔ latency dial**: widen it and late events
   count, but every window publishes that much later.

2. **Correctness under crashes.** No checkpointing → a restart **loses** all
   in-flight state and every event during the outage (loss ∝ downtime). Checkpointing
   → **no loss, but at-least-once**: replayed windows are re-emitted and a naive sink
   **double-counts**. Exactly-once at the store needs **checkpointing + an idempotent
   sink** (canonical key, durable dedup / upsert / transactional).

3. **Backpressure is a *freshness* failure, not a correctness one.** Overload grows
   consumer lag and staleness, but Kafka buffers durably and event-time windows stay
   exact — results just publish late, and recover when load subsides (loss only if
   retention < drain time). Watch for **partition skew**: one hot partition caps
   throughput no matter how many consumers you add.

**One line:** a streaming aggregate is trustworthy only when watermarks, checkpointing,
and an idempotent sink are all correct — and even then it trades freshness under load.

## Parking lot (adjacent gaps — seeds for a NEXT lab, not chased here)

- **Partition skew & scaling** (surfaced by his Scenario-5 question). Keying by a
  low-cardinality field (`event_type`, 4 values) concentrates load onto a few
  partitions — one stayed permanently idle, one was the hot bottleneck. A Kafka
  consumer group's parallelism is capped at partition count *and* by the hottest
  partition, so adding consumers does nothing for a hot partition. Levers:
  high-cardinality partition key, more partitions + parallelism, two-phase
  pre-aggregation to scale a small-cardinality GROUP BY, provision ≥ peak. **This
  is the strongest candidate for the next lab.**
- **`numLateRecordsDropped` counts partials, not raw events.** Flink's two-phase
  window agg (`LocalWindowAggregate` → `GlobalWindowAggregate`) pre-combines
  same-window/same-key records before the late-check. 10 late raw events →
  1 dropped partial on the metric. Implication for prod monitoring: this metric
  is a *lower bound* on lost data, not the count. Worth a dedicated lab.
- **Idempotency keys must be canonical.** A timestamp formatted `…30.000` vs `…30`
  silently defeated the sink's dedup *and* evaded `rows>1` duplicate detection.
  Real idempotency needs a canonical key + a durable (not in-process) dedup store,
  or a transactional/upsert sink. A whole lab could live here.
- **Idle-partition watermark stall** (found in Phase A): with multiple partitions,
  an idle one pins the event-time watermark at −∞ and no window ever fires.
  Fixed here with `table.exec.source.idle-timeout`; the general topic (watermark
  alignment, per-partition idleness) is deep enough for its own lab.

---

## Prediction scorecard

| Scenario | Correct? |
|---|---|
| 1 — late event | ✓ |
| 2 — watermark boundary | ◑ (counted ✓; predicted memory as cost, missed latency) |
| 3 — restart, no checkpoint | ✓ (mechanism correct; magnitude ~4× under-estimated) |
| 4a — restart, checkpoint + at-least-once sink | ✓✓✓ (all three parts correct) |
| 4b — restart, checkpoint + idempotent sink | ✓ (dedupe holds; surfaced the canonical-key bug) |
| 5 — backpressure | ✓✓✓ (all three parts + the partition-skew insight) |

**Final: 5 / 5 scenarios correct on mechanism** (6 predictions logged; one partial —
scenario 2, where you named memory as the cost and missed latency; one magnitude miss
— scenario 3, where downtime was ~4× your estimate). Both misses were where reality
was *more* subtle than intuition — which is exactly what a lab is for. A scorecard this
strong means the domain is largely internalized: **the next lab should be harder**
(partition skew / scaling is the natural pick).
