# Top-K Rollup Lab — Executable Plan

> **Audience:** the model executing this lab. This is a *learning session* for the user
> (Kamlesh), not a build project. You write all code and docs; the USER predicts, runs,
> and interrogates. Never run a failure scenario yourself when he can run it. Never
> reveal a scenario's expected outcome before his prediction is on record.

---

## 0. Scope contract (already confirmed with the user — do not renegotiate)

- **Concept (one sentence):** Top-K over a long window cannot be derived by merging the
  top-K lists of its sub-windows; only full per-key counts (or mergeable sketches) roll
  up correctly — *counts are mergeable, ranks are not.*
- **Observable claim:** A key that never appears in ANY minute's top-K list can be the
  **#1 key of the hour** — from the same ClickHouse table, the naive merge-of-top-Ks
  query omits it while the sum-then-rank query shows it at #1, side by side.
- **Windows:** 1-min base buckets (Flink, event time) stored exactly in ClickHouse;
  30 min / 1 hr / 1 day are **derived at query time** from the 1-min buckets. The two
  derivations (correct vs naive) are the whole lab.
- **Scope ceiling:** reuse the existing `streaming-agg-lab` docker-compose **unchanged**.
  New files only: 1 Flink SQL job, 1 producer driver, 1 compare/query script, 1 CH table
  in `init` or applied manually, this folder's README. No UI, no new services, no CI.
  Anything beyond this: default answer is no.
- **Done → stop:** Done when the failure matrix has **5 scenarios** all run with
  predictions recorded, and the why-doc answers *"why can't top-K be merged, and what
  actually does roll up?"* Then stop. If the user asks to keep going: "Contract's met.
  New concept, new lab."

Parking lot (pre-seeded — do NOT chase these): approximate top-K (`topK()` /
count-min-sketch accuracy under skew), streaming top-K inside Flink
(ROW_NUMBER/retractions), late-data effects on buckets (covered by the parent lab).

---

## 1. Existing harness you are building on (read these before writing code)

Repo: `~/Desktop/sandbox/labs/streaming-agg-lab`. Pipeline shape:

```
Node producer → Kafka 'events' (3 partitions) → Flink SQL → Kafka topic → Node sink → ClickHouse ← Node query
```

- `docker-compose.yml` — Kafka (host listener **localhost:29092**, in-cluster
  `kafka:9092`), Flink 1.20 (UI :8081, SQL files mounted at `/sql`), ClickHouse 24.8
  (HTTP :8123, user/pass/db = `lab`/`lab`/`lab`), Grafana :3000. Topic auto-create is
  OFF — topics are created explicitly.
- `flink/aggregate.sql` — the pattern to copy: Kafka JSON source with
  `WATERMARK ... - INTERVAL '2' SECOND`, `scan.startup.mode = 'latest-offset'`
  (job must be running BEFORE the producer), TUMBLE window, Kafka JSON sink.
- `producer/produce.js`, `lib/config.js` — kafkajs conventions, GROUND-TRUTH printout
  pattern on Ctrl-C.
- `sink/consume.js` — kafkajs consumer → ClickHouse insert. Extend it with a
  `--topic/--table` flag (or add a parallel `sink/topk-sink.js` copying its shape);
  do not fork the compose file for this.
- `clickhouse/init.sql` — note the parent lab stored `window_start` as String (a
  documented gotcha). **This lab uses `DateTime64(3)` properly.**
- `README.md` — start order, reset recipes, lag-introspection commands. Reuse verbatim.

---

## 2. Harness spec (Phase 1)

### 2.1 Time compression (required — a real day is unobservable)

The producer fabricates `event_time`: it replays a **synthetic timeline** (e.g. 60 or
1440 synthetic minutes) as fast as Kafka/Flink can absorb it. Flink windows are
event-time, so synthetic time drives them. Two mechanical requirements:

1. Emit events in (roughly) nondecreasing event_time order so the watermark advances
   cleanly (per-minute batches are fine).
2. After the last real event, emit one **flush event** with `event_time` ≥ last window
   end + watermark delay (use a dedicated key like `_flush`), otherwise the final
   window never fires. (The parent lab's `source.idle-timeout` does not advance
   event-time watermarks.)

### 2.2 New files

```
topk/
  PLAN.md               (this file)
  README.md             (you write: start, reset, steady-state check)
  WHY.md                (Phase 3: failure matrix + why-doc)
flink/topk-minute.sql   1-min TUMBLE COUNT(*) per (window, item_id)
                        source: topic 'events2'  sink: topic 'minute-counts'
producer/topk-produce.js  scenario-driven distribution generator (see 2.3)
sink/…                  extended sink → lab.minute_counts
query/topk.js           the comparator (see 2.4)
```

Topics: `events2` (3 partitions, keyed by `item_id`), `minute-counts` (1 partition).
(Separate topics keep the parent lab's jobs/data untouched — quick to reset.)

ClickHouse table (apply via `clickhouse-client`, and append to `clickhouse/init.sql`
so full resets survive):

```sql
CREATE TABLE IF NOT EXISTS lab.minute_counts (
  window_start DateTime64(3),
  window_end   DateTime64(3),
  item_id      String,
  cnt          UInt64,
  inserted_at  DateTime DEFAULT now()
) ENGINE = MergeTree ORDER BY (window_start, item_id);
```

Plain MergeTree, appends only — same visibility principle as the parent lab: duplicate
inserts must be SEEable (`rows > 1` check in the query script).

### 2.3 Producer distributions (`topk-produce.js`)

Flags: `--scenario <name> --minutes <n> --rate <events-per-synthetic-minute≈2000>`.
Prints GROUND TRUTH on exit: per-key totals AND per-minute top-12, so every scenario
is checkable without trusting the pipeline. Distributions (exact recipes — do not
improvise the sleeper math):

**Implemented exactly as below** (built and smoke-tested end-to-end — see status note
at the bottom of this file):

- **`zipf`** — 50 keys, deterministic zipf(s=1.1) counts, identical every minute (the
  point of the control: a stable ranking across minutes).
- **`sleeper`** — per synthetic minute: `decoyAndSleeperMinute(minute, R=11)` — 10
  *rotating* decoy keys (`decoy-<minute>-1..10`, fresh names each minute) get counts
  100, 99, … 91; key `sleeper` gets **90** (rank 11, every single minute, by
  construction). Over 60 minutes: `sleeper` totals 5400 → the true #1 for the hour,
  absent from every minute's top-10.
- **`burst`** — the *same* `decoyAndSleeperMinute(minute, 11)` recipe every minute
  (deterministic, not zipf — a real zipf background made the sleeper's per-minute rank
  distribution-dependent and hard to guarantee; reusing the sleeper recipe keeps the
  boundary exact) **plus** key `burst` gets 3000 events in exactly one minute
  (`floor(minutes/2)`) and zero elsewhere. Over a day: `sleeper` (1440×90=129,600) ≫
  `burst` (3000).
- **`retain`** — `decoyAndSleeperMinute(minute, R)` with `R` from `--sleeper-rank`
  (default 11) — generalizes the same recipe so `sleeper`'s guaranteed rank is
  configurable, for an optional deeper K′-boundary demo beyond S3's default data.

Every scenario run also sends a **heartbeat**: one message explicitly targeted at each
Kafka partition (bypassing the key hash) every synthetic minute, plus with the flush
event. Required — see the idle-partition gotcha in `topk/README.md`; without it,
Flink's per-partition-min watermark can stall indefinitely and no window ever fires.

### 2.4 The comparator (`query/topk.js`)

One script, flags: `--window 1m|30m|1h|1d --k 10 --retain <K′, default = k> [--tiered]`.
Prints THREE columns side by side from the SAME `lab.minute_counts` data:

1. **CORRECT** — `SELECT item_id, sum(cnt) FROM minute_counts [WHERE window in range]
   GROUP BY item_id ORDER BY 2 DESC LIMIT k`
2. **NAIVE** — CTE: per 1-min bucket keep only its top-K′ rows
   (`ROW_NUMBER() OVER (PARTITION BY window_start ORDER BY cnt DESC) ≤ K′`), then sum
   the *surviving* rows per key, rank, LIMIT k.
3. **NAIVE-TIERED** (`--tiered`, scenario 5 only) — same trick applied twice: minute
   top-K′ → 30-min lists → keep top-K′ of each 30-min list → merge for the day.

Plus a **DIFF line**: keys missing from naive, rank inversions, and each key's
naive-vs-correct count delta. Also print `rows>1` dedup warning and bucket count
scanned. The user must be able to SEE the divergence as a number, not infer it.

### 2.5 Steady-state check (user runs before any scenario)

`--scenario zipf --minutes 5` → `topk.js --window 1m` matches producer ground truth
exactly (1-min buckets are exact); all `rows = 1`. **Do not proceed to Phase 2 until
he confirms this on his machine.**

**Reset between scenarios is two steps, both required — this is not optional
housekeeping, it changes the result:**
```bash
docker compose exec jobmanager ./bin/flink list                              # copy Job ID
docker compose exec jobmanager ./bin/flink cancel <JOB_ID>
docker compose exec jobmanager ./bin/sql-client.sh -f /sql/topk-minute.sql    # fresh job
docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE lab.minute_counts"
```
Each scenario's synthetic timeline is anchored to a **fixed** epoch (not `Date.now()`
— `zipf`=2020-01-01, `sleeper`=2020-01-11, `burst`=2020-01-21, `retain`=2020-01-31),
so window boundaries are deterministic. But Flink's watermark only moves forward
within a job's lifetime, so a job that already processed one scenario's epoch will
silently drop a *different* scenario's (earlier) epoch as late data — nothing fires,
no error. **Restart the Flink job before every new scenario.** Full explanation and
the two other gotchas found during the build smoke-test: `topk/README.md`.

---

## 3. Scenarios (Phase 2 — the core)

Fixed protocol per scenario, zero exceptions:
1. You state the setup mechanically. 2. **He predicts, on record, before running** — a
number, an ordering, or a named behavior; push back once on vague predictions.
3. **He runs it** (you give exact commands). 4. Compare — correct: one sentence;
wrong: Socratic first (he explains the gap before you do); ambiguous: fix
instrumentation before concluding. 5. Log the matrix row immediately:
`scenario | prediction (verbatim) | observed | ✓/✗/partial | one-line takeaway`.

> Expected outcomes below are for YOUR eyes — never shown before his prediction.

**S1 — Control: zipf, 1-hour window, K=10.** Setup: 60 synthetic minutes of stable
zipf; run comparator with `--window 1h`. Ask him to predict: does NAIVE match CORRECT —
list AND counts? *(Expected: lists match — heavy hitters are heavy in every minute;
counts may differ slightly where a head key dipped below rank K′ in some minute. This
is the control: naive usually agrees, which is exactly why this bug ships to
production.)*

**S2 — Sleeper: the headline claim. 1-hour window, K=10.** Setup: `--scenario sleeper
--minutes 60`. Predict: where does `sleeper` rank in CORRECT, and in NAIVE? *(Expected:
CORRECT #1 with 5400; NAIVE omits it entirely — 0 of its 60×90 events survive any
per-minute cut.)*

**S3 — Retention boundary (config/threshold scenario). 1-hour window, K=10, sweep
K′.** Setup: sleeper data stays loaded (no Flink/producer restart needed — this reruns
the comparator only); rerun with `--retain 10, 11, 15, 25`. Predict: the smallest K′ at
which NAIVE's top-10 becomes correct, and whether any K′ < number-of-keys-per-minute is
*guaranteed* correct in general. *(Verified in the build smoke-test: the boundary is
exact — `--retain 10` fails, `--retain 11` recovers sleeper completely, because its
guaranteed rank IS 11 by construction. Sharpen from there: over-retaining only "worked"
here because we know the adversary's rank in advance; there is no distribution
independent K′ — a real adversary just sits at rank K′+1. `--sleeper-rank` on the
`retain` scenario demonstrates this by moving the target rank.)*

**S4 — Burst inversion: 1-day window (time-compressed), K=10.** Setup: `--scenario
burst --minutes 1440` (runs in a few real minutes). Predict the ORDERING of `burst` vs
`sleeper` in CORRECT and in NAIVE for the day. *(Expected: CORRECT ranks sleeper
(≈129 600) far above burst (3000); NAIVE inverts them — burst's one big minute survives
its bucket cut fully while sleeper's 1440×90 all get dropped. Rank inversion, not just
omission: naive doesn't merely lose keys, it promotes the wrong ones.)*

**S5 — Tiered rollup: error compounds. 1-day window via 30-min tier.** Setup: same
day of data; comparator `--tiered` — the "sensible" production design of cascading
materialized top-K lists (minute → 30-min → day). Predict: is NAIVE-TIERED better,
same, or worse than flat NAIVE, and why. *(Expected: same-or-worse — each tier's cut
discards more mass; anything below rank K′ in a 30-min list dies even if it survived
the minute tier. The design lesson: cascade COUNTS (or mergeable sketches) across
tiers, rank only at the end. This is precisely what a ClickHouse SummingMergeTree /
AggregatingMergeTree rollup gets right — one sentence in the why-doc, not a build.)*

Mid-session scope requests get one answer: **"That's outside the contract. Parking lot
or new lab?"**

---

## 4. Deliverables (Phase 3) and stop

When S5's row is logged, write `topk/WHY.md`:

1. **Failure matrix** — all 5 rows, his predictions verbatim (do not clean them up).
2. **Why-doc** (≤1 page): observable claim → what the runs showed → the 2–3 sentences
   he should reproduce cold in an interview (target shape: *"Top-K doesn't compose:
   ranks are not mergeable, counts and sketches are. Store the finest-grain full
   counts (or a mergeable sketch like count-min + heap with stated error), roll up
   counts across tiers, and rank only at the final window. Any design that merges
   top-K lists is wrong for adversarial and even mildly flat distributions, and the
   error compounds per tier."*) → parking-lot items (pre-seeded list above + anything
   S1–S5 surfaced).
3. **Prediction scorecard** — n/5 correct, wrong ones named. Compare against his
   running trend (streaming-agg 5/5; storage-layout 1✓/3◑/2✗; page-cache 3✓/2◑;
   workload-bounds 0✓/4◑/1✗) and update the memory file
   `streaming-agg-lab-progress.md` (or a new `topk-lab-progress.md`) in auto-memory.

Then **stop**. Grade honestly — no "close enough" on predictions that flip a design
decision (S3's "is any K′ safe?" and S4's ordering are exactly such predictions).

---

## 5. Build status

**Harness built and smoke-tested end-to-end (2026-07-13). All files in section 2.2
exist and work. Phase 2 (the user-facing scenarios) has NOT been run yet — the
smoke-test below stood in for the user's seat to prove the mechanics, but every
prediction step in section 3 is still owed to him.**

What was verified directly against the running stack:
- Steady-state check (`zipf --minutes 5` → `--window 1m`) matches producer ground
  truth exactly.
- Multi-bucket rollup arithmetic (`--window 1h` summing 4 buckets) is exact.
- **S2 mechanic confirmed**: clean 15-minute `sleeper` run → CORRECT top-1 = `sleeper`
  (1350 = 15×90); NAIVE `naive_total=0` for `sleeper`, "never survived a per-minute
  cut" — the headline claim reproduces.
- **S3 mechanic confirmed**, and sharper than planned: `--retain 10` excludes
  `sleeper`, `--retain 11` recovers it completely — an exact threshold at the
  construction rank, not a fuzzy one.
- **S4 mechanic confirmed** at reduced scale (180 synthetic minutes, not the full
  1440 — scale doesn't change the mechanism): CORRECT ranks `sleeper` (16,200) above
  `burst` (3000); NAIVE inverts them, promoting `burst` to #1 and dropping `sleeper`
  entirely. All 180 windows fired within seconds of the flush event (time compression
  works at this scale).
- `--tiered` (S5's flag) runs without error and produces a plausible three-way split;
  not run against the actual `burst` 1440-minute dataset with predictions logged.
- Full reset (docker compose down -v / up) not re-verified after these changes — the
  init.sql addition was verified to apply on a genuinely fresh volume.

Three real bugs were found and fixed during this smoke-test (all documented inline in
code comments and in `topk/README.md`'s gotchas section — do not reintroduce them):
1. Off-by-one range boundary in `query/topk.js` (`>` → `>=`) that silently dropped the
   earliest bucket of every window, breaking `--window 1m` outright.
2. Idle-partition watermark stall — fixed with explicit per-partition heartbeats in
   the producer (`table.exec.source.idle-timeout` alone did not reliably prevent it
   here, despite being the parent lab's documented fix for the same class of bug).
3. `Date.now()`-anchored synthetic timelines collide across runs since Flink's TUMBLE
   windows are epoch-anchored — fixed with fixed, scenario-specific epoch offsets, at
   the cost of requiring a Flink job restart before every new scenario (Flink's
   watermark is monotonic per job lifetime; see section 2.5).

**Before resuming with the user:** restart the Flink job and truncate ClickHouse
(section 2.5) — the table was left empty and a `burst` job was left running after
this smoke-test, anchored at `burst`'s epoch. Then go run the steady-state check with
him for real, and proceed to S1.
