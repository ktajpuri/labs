# Question Bank — Failure Labs (single recall source)

<!-- CONSUMER INSTRUCTIONS (scale-trigger-drill: Type A at session end; failure-lab-builder: Type B warm-up probes)
1. SELECT: ask the entry with the oldest last_asked; "—" (never asked) counts as oldest. Tie-break at random within the eligible type.
2. UPDATE: after asking, set that entry's last_asked to today's date (YYYY-MM-DD). Never modify any other entry's date.
3. GRADE: against the grade_note's essential elements (mechanism named, direction of effect, key condition/threshold) — a paraphrase containing all elements is a full pass; a miss = a missing or wrong mechanism/direction/condition, never imperfect phrasing.
4. LOG: record misses to the Interview Error Log tagged "recall" (distinct from beat-miss tags).
5. NEVER RE-TEACH in-session: on a miss, state the ref answer once and move on — the miss goes to the log, not to a lesson.
-->

<!-- REGENERATION: this file is MERGED, never rebuilt — preserve ids and last_asked values, add entries only for new labs or genuinely new findings, mark removed-lab entries "retired" instead of deleting. -->

---

## dist-txn-lab

### [dist-txn-A1]
- lab: dist-txn-lab
- type: A
- last_asked: 2026-07-18
- q: A transfer service commits a debit on DB-A then a credit on DB-B as two plain commits. A crash between them left the system 100 short; your harness showed an operator rerun then produced 800/1100 — still 100 short, alice double-debited. The team's runbook fix is "on partial failure, re-run the transfer job." Drill.
- ref: A retry of a non-atomic dual-write can't repair it because the retry has no way to know which half already happened — it re-executes both halves, double-applying the one that succeeded (the harness's 900/1000 → 800/1100, invariant violated both times). The gap is structural: no ordering of independent commits is atomic, and no blind retry fixes it. Real fixes change the shape: an atomic commitment protocol (2PC), a saga with compensations, or at minimum idempotency keys per step so a retry becomes a no-op on the half that already ran.
- grade_note: targets Decision (blind retry double-applies) + Road Not Taken (2PC / saga / idempotency keys). Miss = endorsing rerun, or a fix that doesn't address which-half-already-happened.

### [dist-txn-A2]
- lab: dist-txn-lab
- type: A
- last_asked: 2026-07-18
- q: Ops finds prepared transactions from a dead coordinator sitting on a Postgres participant, writers timing out behind their locks. The proposed runbook: "old prepared txns are stale garbage — ROLLBACK PREPARED anything older than 10 minutes." Using the lab's S3/S4 pair, drill.
- ref: S3 and S4 were byte-identical from the participant's view — both prepares voted YES, coordinator silent — yet one was globally uncommitted (no decision on record → presumed abort correct) and the other was COMMITTED (decision logged; recovery must roll FORWARD). A participant-side age heuristic can't distinguish them; blind rollback of a decided-commit txn breaks atomicity exactly when the other participant already committed (XA calls this heuristic damage). The runbook must consult the coordinator's decision log — the log write IS the commit point — and only presume abort when no decision exists.
- grade_note: targets Decision (age is not evidence of global state) + mechanism (commit point = coordinator log write, participants indistinguishable). Miss = endorsing age-based rollback, or not naming the coordinator log as the arbiter.

### [dist-txn-A3]
- lab: dist-txn-lab
- type: A
- last_asked: —
- q: During a 2PC in-doubt incident, monitoring shows all read dashboards green — balance queries returning instantly — so the team downgrades severity, reasoning "the locks are only theoretical, reads are fine." Your harness's contender told a different story. Drill.
- ref: Both observations are correct and the conclusion is wrong: MVCC serves readers the pre-transaction row version, so SELECTs never queue behind an in-doubt txn's locks — but every WRITER needing those rows blocks (the harness's contender burned its full 5s lock_timeout and failed), and the hold is UNBOUNDED: no timeout, no vacuum relief, survives participant restarts (the vote is a WAL write in pg_twophase), until a coordinator decision arrives. Read-path health is structurally blind to this failure; severity must be judged on writer latency/lock waits (pg_locks, blocked-writer counts), and the unbounded-quiet-damage mode is exactly why max_prepared_transactions defaults to 0.
- grade_note: targets Untouched (MVCC hides the damage from read metrics) + Ceiling (locks unbounded until decision). Miss = agreeing reads-green means low severity, or expecting the locks to expire on their own.

### [dist-txn-B1]
- lab: dist-txn-lab
- type: B
- last_asked: 2026-07-17
- q: (Predict) A Postgres participant holds a prepared 2PC transaction (voted YES, coordinator dead) and the container is restarted. Predict: does the prepared txn survive in pg_prepared_xacts, are its row locks still held, and what mechanism decides — contrast with an ordinary open transaction under the same restart.
- ref: It survives with locks intact — the harness's prepared txn reappeared after docker restart with its age ticking uninterrupted from the original prepare — because PREPARE TRANSACTION writes the transaction's complete state to the WAL (pg_twophase) BEFORE answering YES: the vote is itself a durable write, a promise that must survive anything a commit would survive. An ordinary open transaction is connection-bound memory state and is simply aborted by the restart. That asymmetry is the whole point of the prepare phase.
- grade_note: essential = survives with locks + WAL/pg_twophase durable-vote mechanism + ordinary-txn contrast. Miss = predicting the restart clears it, or no durable-write mechanism.

### [dist-txn-B2]
- lab: dist-txn-lab
- type: B
- last_asked: —
- q: (Explain-mechanism) A saga's step 2 fails and compensation restores all balances. Explain why "the saga rolled back" is the wrong sentence — what does the database history actually contain vs a 2PC abort — and why a reader that acted during the gap can never detect it acted on "wrong" data.
- ref: Nothing rolled back: T1 was a real local commit, visible to everyone the instant it landed, and the compensation C1 is a second, forward-running committed transaction that happens to net T1 to zero — the harness showed two committed txns on bank-a where 2PC's abort path left zero history. Because the intermediate state (total=1900, ~15s in the harness) was genuine committed data, any reader's decision made on it was correct AT THE TIME by the database's own account, and after C1 no marker distinguishes the window from normal state — sagas trade isolation away, and the anomaly is undetectable after the fact.
- grade_note: essential = compensation is a new committed txn (not undo), 2PC-abort-leaves-no-history contrast, window state is real committed data with no after-the-fact marker. Miss = describing compensation as rollback, or claiming the anomaly is detectable later.

### [dist-txn-B3]
- lab: dist-txn-lab
- type: B
- last_asked: —
- q: (Boundary) Same transfer, same failure timing (remote step fails / coordinator dies mid-protocol). State what an unrelated writer needing the debited row experiences under 2PC vs under a saga, with the lab's numbers — and name the single design property each behavior is the price of.
- ref: Under 2PC the writer blocks behind the in-doubt txn's locks until its lock_timeout kills it (harness: full 5,009 ms burned, then error) — the price of atomicity-with-isolation: locks must span the global decision, and the decision can be arbitrarily late. Under a saga the writer succeeds in single-digit ms even mid-anomaly (harness: 2–4 ms repeatedly inside the 15 s window) — nothing holds locks between steps, but the price is that the writer (and every reader) is operating on intermediate state that compensation may later net away. Blocking and lost isolation are the two ends of the same dial; there is no third setting that avoids both without weakening something else (the parking-lot countermeasures — semantic locks, pending states — are partial isolation bought back by hand).
- grade_note: essential = blocked-until-timeout vs instant-success with the price named on each side (atomicity/isolation ↔ availability/lost isolation). Miss = describing either behavior without its price, or claiming a free third option.

---

## model-routing-lab

### [routing-A1]
- lab: model-routing-lab
- type: A
- last_asked: —
- q: Your cascade escalates on `confidence < threshold`. At threshold=0.5, the local model's one wrong answer in an 8-query set carried confidence exactly 0.5 — and it did NOT escalate; accuracy stayed at 7/8. At threshold=0.7, that same query (still confidence 0.5) DID escalate, accuracy hit 8/8, at a fraction of the cost the threshold=0.9 sweep needed to reach the same accuracy. A teammate proposes standardizing on threshold=0.5 "since it's a real number the model actually produced, unlike an arbitrary round value like 0.7." Drill the decision.
- ref: The teammate's logic inverts the actual risk: 0.5 is dangerous BECAUSE it's a value the model produces, sitting exactly on the boundary, and the escalation check's strict `<` means any wrong answer parked exactly at the threshold silently fails to escalate — this is a mechanically guaranteed leak, not a probabilistic one. The fix isn't "pick a round number" vs "pick an observed value" — it's recognizing that any threshold equal to a value the model can actually emit is a coin-flip risk at that exact point, and the safer design either uses `<=` or picks a threshold strictly between two observed clusters (0.7 sits cleanly between the model's 0.5-wrong cluster and 0.8/0.9-correct cluster here).
- grade_note: targets Decision (why "real observed value" is backwards reasoning) + mechanism (strict `<` at an exact-match threshold leaks silently). Miss = endorsing 0.5 as safer because it's "real," or not naming the strict-inequality leak.

### [routing-A2]
- lab: model-routing-lab
- type: A
- last_asked: —
- q: To catch what confidence misses, the team swaps the escalation signal from self-reported confidence to a structural check PLUS a one-line Haiku plausibility judgment ("does this look like a valid address?"). Your harness measured this "verifier" cascade cost 4x the confidence cascade for IDENTICAL accuracy (8/8 both ways) — two of its three escalations were false positives, cases where the local model was already correct but Haiku rejected it anyway. The team calls this "the more reliable design" and ships it. Drill.
- ref: The label is wrong — Haiku's one-line plausibility check is not a ground-truth verifier, it's another LLM producing a soft judgment call, the same fallible category as the confidence score it replaced, just relabeled and paid for. The ONLY genuinely reliable half of this design was the structural (regex/schema) check, which caught the one real defect independently of Haiku. "More reliable" requires evidence the added signal catches something the cheaper one missed AND doesn't add net-new false escalations — this run showed the opposite: same catches, worse false-positive rate, 4x cost.
- grade_note: targets Decision (a second LLM call isn't inherently a verifier) + Tiebreaker (accuracy parity + cost delta is the actual evidence, not the label "verifier"). Miss = accepting "verifier" as inherently more reliable without checking accuracy delta.

### [routing-A3]
- lab: model-routing-lab
- type: A
- last_asked: —
- q: You built a confidence-threshold cascade (escalate below 0.7) and validated it against a 3B local model: 8/8 accuracy after cascade, only 1 escalation. You then swap in a weaker 1B local model — same router code, same threshold, same 8 queries — and rerun. Before looking at the result: does the 8/8 accuracy validation from the 3B run tell you anything about what the 1B run will do?
- ref: No — the router's accuracy guarantee was never a property of the router code, it was a property of THAT model's confidence happening to discriminate right from wrong on that run. Swapping to the 1B model (same code, same threshold) dropped accuracy to 50%: the weaker model was wrong on 5/8 queries, and 4 of those 5 wrong answers carried the identical confidence (0.8) as its correct answers, so they never crossed the 0.7 threshold and shipped silently. A router's validated accuracy is not transferable across the model it's routing for — it has to be re-validated per model, because the escalation signal's reliability is a property of the model being escalated FROM, not the routing logic itself.
- grade_note: targets Untouched (accuracy validation doesn't transfer across models) + mechanism (same confidence value on right and wrong answers = the threshold can't discriminate). Miss = assuming router correctness generalizes once validated against one model.

### [routing-B1]
- lab: model-routing-lab
- type: B
- last_asked: —
- q: (Boundary) A local model's self-reported confidence on a golden set clusters tightly at 0.8/0.9 for correct answers and 0.5 for its one wrong answer — a clean separation. Predict what happens to escalation rate and accuracy as the confidence threshold sweeps from 0.5 up through 0.9, and identify where the cost/quality "knee" sits and why.
- ref: Escalation rate is a step function of the threshold relative to the two clusters, not a smooth curve: at or below 0.5 (given strict `<`), the wrong answer's exact-0.5 confidence fails to trigger escalation at all (0% escalate, accuracy capped at the raw local rate); anywhere strictly above 0.5 up to 0.8, the wrong answer escalates alone (minimal escalation, full accuracy recovered cheaply); pushing above 0.8 additionally escalates every CORRECT answer in that cluster, ballooning cost with zero accuracy gain. The knee sits at the boundary just above the wrong answer's cluster — past it, cost grows linearly for flat accuracy.
- grade_note: essential = step-function shape (not smooth), the exact-equality leak at the lower boundary, and the knee located just above the wrong-answer cluster. Miss = predicting a smooth accuracy/threshold curve, or missing the boundary leak at the lower end.

### [routing-B2]
- lab: model-routing-lab
- type: B
- last_asked: —
- q: (Explain-mechanism) A cascade design assumes that when a local model is wrong, its self-reported confidence will tend to be higher than when it's right — the "confidently wrong" failure mode. Explain why a self-reported confidence field from an LLM has no structural reason to correlate with actual correctness at all.
- ref: The confidence number is produced by the same next-token generation process as every other field in the output — the model isn't consulting an internal, measured uncertainty signal (like token-level output probabilities or an ensemble disagreement score), it's pattern-completing what a plausible-sounding confidence value looks like for a JSON field labeled "confidence," conditioned on how clean or complete the input LOOKS on the surface. A short, clear-looking message can get low confidence for idiosyncratic reasons (as observed: the clearest message in a set scored the lowest confidence) while a genuinely garbled one scores high, because the signal correlates with surface pattern-familiarity, not with ground-truth correctness.
- grade_note: essential = confidence generated by the same generative process (not a measured/calibrated statistic) + no structural link to correctness. Miss = assuming confidence tracks task difficulty or correctness by default.

### [routing-B3]
- lab: model-routing-lab
- type: B
- last_asked: —
- q: (Spot-the-flaw) A regex-based intent matcher requires a 5-digit order number AND a keyword like "cancel" or "status" anywhere in the message; it's deployed as "handles the easy 30% of tickets for free." On a multi-issue dispute message that mentions an order number early and the word "status" later in an unrelated sentence, the matcher confidently answers using the WRONG order number and ignores the rest of the message. What's the flaw, and what does the deployment claim get wrong?
- ref: The matcher has no way to verify that the order number and the keyword it matched are actually about the same sub-topic — it takes the FIRST order number in the text regardless of which clause the trigger keyword appeared in, so on multi-issue text it silently pairs unrelated fragments into a wrong, confident answer. "Handles 30% for free" measured coverage (how often it claims a match) without measuring precision (how often the claim is right) — a lab run showed a 20% false-claim rate among matches, entirely concentrated in non-trivial-tier text that happened to contain an incidental keyword.
- grade_note: essential = no verification that keyword and order-id are topically linked (first-match, not same-clause) + coverage-without-precision as the deployment-claim flaw. Miss = describing the failure without naming the false-claim/precision gap.

---

## oauth-jwt-logout-lab

### [oauthjwt-A1]
- lab: oauth-jwt-logout-lab
- type: A
- last_asked: —
- q: Your Scenario 2 harness: `RS_CHECK_DENYLIST=false`, logout revoked the token server-side (`accessTokenRevoked: true`), yet replaying the same saved token still returned 200. A teammate proposes "logout doesn't need to touch the server at all — deleting the token client-side is functionally equivalent to server-side revocation, since the user can't use a token they don't have." Drill.
- ref: This conflates the client's copy of the token with the token's overall validity. Client-side deletion only protects against the same legitimate user's own future accidental reuse — it does nothing against a token already captured elsewhere (browser history, an XSS exfil, a proxy log, a second device, a network capture). The harness demonstrated exactly this: `.tokens/current.json` was deliberately never deleted by `logout`, and the resource server accepted the replay identically to the original holder, because the token itself IS the credential — a second holder of the same bytes is indistinguishable from the first to a stateless verifier. Real revocation requires the resource server to check something outside the token's own bytes.
- grade_note: targets Decision (client-side deletion defends against forgetting, not theft/replay) + Untouched (a second holder of identical token bytes is authorized identically). Miss = accepting client-side-only logout as sufficient.

### [oauthjwt-A2]
- lab: oauth-jwt-logout-lab
- type: A
- last_asked: —
- q: Scenario 3's fix (`RS_CHECK_DENYLIST=true`) correctly rejected a token whose jti was on the denylist. The team ships it exactly as built — a Set that only ever grows, one entry added per logout, entries never removed. At scale (millions of logouts/day) they hit unbounded memory growth on the authz server and conclude "we need a bigger box." Drill.
- ref: More memory treats the symptom, not the bug. A jti only needs to be checked while its token could otherwise still pass the `exp` check on its own — once a token's `exp` has passed, the resource server rejects it on the TTL check alone regardless of denylist state, so retaining that jti forever buys zero additional protection past its own expiry. The fix is a TTL on denylist entries matching (or slightly exceeding, for clock skew) each token's own `exp` — bounding the denylist's size to "logouts within one access-token lifetime," not "all logouts ever." Buying a bigger box ships a scaling workaround for a staleness problem that has a cheap, exact fix.
- grade_note: targets Ceiling (denylist only needs to cover the token's own remaining TTL window) + Decision (TTL-bound the store vs. scale the hardware). Miss = endorsing "bigger box" as the right first move, or not connecting denylist necessity to the token's own exp.

### [oauthjwt-A3]
- lab: oauth-jwt-logout-lab
- type: A
- last_asked: —
- q: After Scenario 6, the team sets `RS_PIN_ALG=true` on `resource-server.js` and declares "the JWT algorithm-confusion class of bugs is closed." Using this lab's own Scenario 6 finding, what's the flaw in "closed"?
- ref: Pinning closes the `alg=none` and HS/RS-confusion paths for this one resource server's code — but algorithm confusion is a two-layer problem: server-side policy (pinning, which is per-service and easy to forget on the next service stood up against the same IdP) and library-level defaults (whether the JWT library itself refuses to treat asymmetric key material as a symmetric secret). This lab's own run showed `jsonwebtoken` has exactly such a guard built in, independent of `RS_PIN_ALG` — proof the attack class is well-known enough that library authors defend against it too. "We pinned it here" is necessary and correct, but it's scoped to one service's config, not a claim about every other consumer of tokens from the same IdP, nor about whether some other team's older library lacks the same guard.
- grade_note: targets Road Not Taken (defense must exist per-consumer across an org, not just in the one audited service) + mechanism (why a JWT library would add its own independent guard). Miss = treating one server's `RS_PIN_ALG=true` as closing the vulnerability everywhere it could recur.

### [oauthjwt-B1]
- lab: oauth-jwt-logout-lab
- type: B
- last_asked: 2026-07-17
- q: (Predict) Given `ACCESS_TTL=N` seconds and `RS_LEEWAY=0`, predict at exactly which elapsed second (measured from `iat`) a valid token's status flips from 200 to 401, and name the comparison operator responsible.
- ref: Flips at t=N, not t=N+1 — the boundary trips the instant N whole seconds have elapsed. `jsonwebtoken`'s expiry check is `clockTimestamp >= exp` (a `>=`, not `>`), and `exp = iat + N`. The lab's own per-second polling loop showed this precisely for N=60: `t+59s → 200`, `t+60s → 401` — the original in-session prediction of "flips at t=61" was off by exactly one second for missing this operator.
- grade_note: essential = flip at t=N not N+1, and naming the `>=` comparison as the mechanism. Miss = predicting t=N+1, or describing the boundary as gradual/fuzzy rather than a single-second step.

### [oauthjwt-B2]
- lab: oauth-jwt-logout-lab
- type: B
- last_asked: 2026-07-16
- q: (Explain-mechanism) A resource server verifies a JWT purely by checking its RS256 signature against a cached public key, plus its `aud`/`iss`/`exp` claims — no call to the authz server at request time. Explain why "the user logged out" has zero effect on this check, and name the one thing that would give it an effect.
- ref: The verification path only inspects the token's own bytes and locally-known claims/keys — "logout" is an action recorded entirely in the authz server's separate state (a denylist entry, a revoked refresh-token family), and nothing in the resource server's check path reads that state, so there is no channel for the logout to reach it. The one thing that gives logout an effect is making the resource server consult server-side state per request — e.g. checking the token's `jti` against a live denylist — which necessarily reintroduces the network dependency the stateless design existed to avoid.
- grade_note: essential = verification checks only the token's own bytes/claims; logout is separate server-side state never consulted by that path; denylist-check is the only lever connecting the two. Miss = asserting logout "should" invalidate it without naming why the current check path structurally can't see it.

### [oauthjwt-B3]
- lab: oauth-jwt-logout-lab
- type: B
- last_asked: —
- q: (Spot-the-flaw) A team fixes an `alg=none` vulnerability by pinning `RS_PIN_ALG=true` (always verify with `algorithms:['RS256']`) and declares the JWT algorithm-confusion class of bugs closed, full stop. Using this lab's Scenario 6 result, what's wrong with "closed, full stop"?
- ref: Pinning closes the `alg=none` and HS-confusion paths for this one resource server's verification code — but it's a service-scoped fix, not an organization-wide guarantee. This lab's own harness found a second, independent layer of defense already present: the `jsonwebtoken` library itself refuses to treat PEM/DER-shaped (asymmetric) key material as an HS-family secret, regardless of `RS_PIN_ALG`. That a mainstream library ships this guard is itself evidence the attack class is common enough to need defense at multiple independent layers — any other consumer of tokens from the same IdP that pins incorrectly, or runs an older library lacking that guard, remains independently exploitable.
- grade_note: essential = pinning is necessary but service-scoped, not org-wide; library-level defense is a second, independent layer this lab's own run surfaced. Miss = agreeing pinning alone fully closes the vulnerability class everywhere it could recur.

---

## page-cache-lab

### [page-cache-A1]
- lab: page-cache-lab
- type: A
- last_asked: —
- q: Your harness scanned a 250MB table (32,832 pages) with shared_buffers=128MB. The warm re-scan reported `hit=192 read=32640` — a 99.4% buffer "miss" rate — yet took 114 ms vs 742 ms fully cold. A teammate sees the 99.4% miss rate on a dashboard and proposes raising shared_buffers from 128MB to most of RAM to "fix the hit ratio." Which ceiling does the miss rate actually indicate, and does the proposal address it?
- ref: Postgres `read` counts requests to the OS, not disk reads — the 32,640 "misses" were served by the OS page cache at ~4 µs/page (vs ~58 µs cold, per track_io_timing). Steps a correct answer contains: (1) the signal that matters is per-page I/O latency / fincore residency, not hit ratio; (2) the big scan runs in a ~96-page ring buffer because the table exceeds shared_buffers/4 (32MB here), so no realistic shared_buffers size makes a bulk seq scan cache in tier 1 — Postgres deliberately delegates bulk data to the OS cache; (3) growing shared_buffers shrinks the OS page cache that is actually serving these reads — which is why ~25% of RAM is the convention, not 90%.
- grade_note: targets Number (miss rate is not a disk-read count) and Decision / Road Not Taken (ring-buffer quarantine means bigger shared_buffers can't capture the scan; the OS tier is doing the work). Miss = treating hit ratio as a disk signal, or not knowing the ring-buffer rule.

### [page-cache-A2]
- lab: page-cache-lab
- type: A
- last_asked: —
- q: In your harness the same 32,832-page scan cost 136 ms right after a Postgres restart but 742 ms fully cold — both runs reporting identical `hit=0 read=32832`. The team's failover runbook budgets the same recovery time for "process restart" and "host reboot." Which ceiling separates the two numbers, and what does the runbook get wrong?
- ref: The two cache tiers are evicted independently: a Postgres restart wipes shared_buffers but leaves the OS page cache intact (136 ms recovery); a host reboot loses both tiers (742 ms). Steps: (1) the caches never coordinate on fill or eviction; (2) Postgres's own counters are identical in both cases — only the OS-tier state differs, so the DB's metrics can't tell you which recovery you're in; (3) the budget must be set by the cold-disk path, and the lab's 5–6× cold/warm gap understates production (Docker-VM-on-SSD; EBS/network storage is 100×+).
- grade_note: targets Ceiling (which tier bounds recovery) and Untouched (the lab's ratio understates real storage). Miss = not distinguishing which event wipes which tier.

### [page-cache-B1]
- lab: page-cache-lab
- type: B
- last_asked: —
- q: (Predict) shared_buffers=128MB. A 19MB table and a 250MB table are each cold-scanned once, then immediately re-scanned. Predict the `hit`/`read` shape of both re-scans and why they differ.
- ref: The 19MB table is below shared_buffers/4 (32MB), so one scan fully caches it: re-scan shows `hit=2460 read=0`, ~17.5 ms. The 250MB table is above the threshold, so it scans through a small ring buffer (~32 buffers per process, 96 pages across 3 workers): the re-scan still reports ~99% `read` (hit=192 read=32640) but runs fast (~114 ms) because the OS page cache serves those reads. Steps: the shared_buffers/4 threshold; ring quarantine protecting the hot working set; tier 2 serving the "misses."
- grade_note: essential = the shared_buffers/4 threshold, ring-buffer behavior for the big table, small table fully cached in one scan. Miss = predicting the big table warms shared_buffers on repeat scans.

### [page-cache-B2]
- lab: page-cache-lab
- type: B
- last_asked: —
- q: (Spot-the-flaw) An engineer sees the Postgres buffer hit ratio fall from 99% to 60% and declares "we're disk-bound now." What's wrong with the inference, and which two instruments settle it?
- ref: `read=N` means "asked the OS for N pages" — it cannot distinguish page-cache hits from disk reads, so a falling hit ratio may cost microseconds, not milliseconds. Settle it with (1) track_io_timing per-page latency (lab: ~58 µs/page true-cold vs ~4 µs/page page-cache) and (2) fincore residency of the data files. Hit ratio alone can't tell a healthy system from a dying one.
- grade_note: essential = "read" counts OS requests not disk reads, plus at least one latency instrument and one residency instrument. Miss = accepting hit ratio as a disk signal or naming no instrument.

### [page-cache-B3]
- lab: page-cache-lab
- type: B
- last_asked: —
- q: (Explain-mechanism) Right after dropping the OS page cache (`drop-oscache`, fincore shows 0B), a scan of a small previously-hot table reports `hit=2460 read=0` with no I/O line at all. Explain how those pages survived the purge.
- ref: The tiers are independent: drop_caches empties only the kernel page cache; shared_buffers is Postgres's own process memory and is untouched, so the scan never asks the OS for a single page (hence no I/O line). Fill and eviction are uncoordinated in both directions — restart-pg wipes tier 1 and leaves tier 2, drop_caches does the reverse — so every hot/cold combination per tier is reachable.
- grade_note: essential = independence of the two tiers + which tier drop_caches touches. Miss = believing eviction in the lower tier invalidates copies in the upper one.

---

## partition-skew-lab

### [partition-skew-A1]
- lab: partition-skew-lab
- type: A
- last_asked: —
- q: Your harness ran skewed keys (90% on `hot`) into 4 partitions / 4 consumers, each consumer capable of ~100 msg/s: the hot partition's consumer pinned at ~98/s against ~175/s incoming, lag growing ~77/s while the other 3 partitions sat near 0. The team proposes scaling the consumer group to 8 members. Which ceiling does that address?
- ref: None — a consumer group never assigns more than one consumer per partition, so the hot partition's single consumer IS the ceiling; extra members go idle (the harness's 5th consumer got `assigned partitions: []` and processed 0). Steps: (1) ceiling = the hot partition's single-consumer capacity (~100/s), not aggregate consumer count; (2) each join still forces a stop-the-world rebalance on every existing member for zero gain; (3) the real levers are the key distribution itself (salting) or per-message processing speed.
- grade_note: targets Ceiling (one-consumer-per-partition rule) and Road Not Taken (idle members + rebalance cost; salting as the lever). Miss = believing consumers beyond the hot partition's one helper add throughput.

### [partition-skew-A2]
- lab: partition-skew-lab
- type: A
- last_asked: —
- q: Mid-incident the team grows the topic 4→8 partitions expecting immediate relief. Your harness showed the admin/monitor saw 8 partitions instantly, but the consumer group kept its old assignment — kafkajs's `metadataMaxAge` defaults to 300,000 ms — and the `hot` key stayed on partition 2 after growth, with partitions 4–7 carrying zero traffic. What does the drill say about this fix?
- ref: (1) Partition growth affects only future produces and never re-routes already-hashed keys — here every existing key still hashed into 0–3, so the skew was untouched; (2) the running group doesn't notice new partitions until its metadata cache TTL (5-min default) expires or it restarts — a bounded cache, not a hard restart requirement; (3) the post-growth rebalance can even make things worse if the assignor pairs the hot partition with another loaded one on the same consumer — the harness's benign pairing (hot partition 2 with silent partition 4) was luck, not a guarantee.
- grade_note: targets Number (the 5-minute metadataMaxAge boundary) and Untouched (assignor-pairing risk after growth). Miss = expecting existing hot traffic to redistribute, or calling the delay a hard restart requirement.

### [partition-skew-A3]
- lab: partition-skew-lab
- type: A
- last_asked: —
- q: To fix the hot key the team salts it into 8 sub-keys over 4 partitions. Your harness observed 6 of the 8 buckets hashing onto partition 2 (a 6/2/0/0 split) with lag climbing past 11k — while `--salt 50` flattened lag to 0–6 everywhere, with the busiest partition at ~70–80/s. The team wants to ship salt=8 anyway because "salting is the textbook fix." Drill the decision.
- ref: Salting is a numbers game against the partition count, not a guarantee: with only 8 buckets over 4 partitions, a 6/2/0/0 hash collision is within normal hash variance, recreating the skew one level down. The success criterion isn't equal partitions — it's every partition staying under its consumer's ~100/s ceiling, which 50 buckets achieved by giving the hash room to average out. Diagnose with the producer's own key→partition log; monitor/consumer logs alone can't explain why a salt fails.
- grade_note: targets Decision (bucket count vs hash variance) and Tiebreaker (success = under the per-consumer ceiling, not uniformity). Miss = treating salting as effective at any bucket count, or wrong success criterion.

### [partition-skew-B1]
- lab: partition-skew-lab
- type: B
- last_asked: —
- q: (Boundary) 4 partitions, 4 consumers at ~100 msg/s each, skewed load already lagging on the hot partition. A 5th consumer joins the group mid-run. State (a) what assignment it gets, (b) what the other 4 consumers experience at the moment it joins, and (c) the effect on hot-partition lag growth.
- ref: (a) No partitions — it idles. (b) A full stop-the-world rebalance fires anyway: the coordinator can't know the outcome in advance, so every member gets "group is rebalancing, rejoin needed" — and the cost lands unevenly by rejoin speed (lab: hot-partition consumer rejoined in 25 ms, cold ones took up to 2.5 s; ~7-message dip on the hot partition, not the ~300 a naive everyone-pauses-equally estimate gives). (c) Lag growth is unchanged — the hot consumer holds its ~98/s ceiling before and after.
- grade_note: essential = idle assignment, rebalance-fires-regardless (outcome-blind coordinator), unchanged growth rate. Miss = claiming no rebalance because assignment didn't change, or claiming lag improves.

### [partition-skew-B2]
- lab: partition-skew-lab
- type: B
- last_asked: —
- q: (Spot-the-flaw) An engineer builds a consumer-throughput dashboard from committed-offset deltas sampled every few seconds, sees a bursty rate, and concludes the consumer stalls periodically. What's the flaw, and what should each rate be read from instead?
- ref: kafkajs autocommits at batch boundaries, not smoothly — committed-offset deltas are bursty by construction at short windows, so the "stalls" are a commit-timing artifact. Read processing rate from the consumer's own per-message counter (incremented where the work happens), and incoming rate from the partition high-water mark, which is independent of consumer commit timing.
- grade_note: essential = commit-at-batch-boundary as the artifact + at least one correct alternative instrument (per-message counter or high-water). Miss = accepting the offset-derived rate as real.

### [partition-skew-B3]
- lab: partition-skew-lab
- type: B
- last_asked: —
- q: (Predict) Uniform keys at ~200/s into 4 partitions; consumers each handle ~100 msg/s; you scale the group 1→2→3→4→5. Ops expects aggregate lag to shrink smoothly with each added consumer. What actually happens at each step, and at 5?
- ref: Relief is a per-partition step function, not a smooth aggregate curve — each new consumer only relieves the specific partitions it takes over; whichever partition lacks a dedicated consumer keeps lagging (lab: into the 1000s) and collapses sharply the moment it gets one, not gradually. At 4 consumers the system returns to baseline (lag 0–3); the 5th is idle. The ceiling is exactly the partition count, independent of key distribution.
- grade_note: essential = step-function-per-partition shape + benefit capped at partition count. Miss = smooth-aggregate model, or expecting the 5th consumer to contribute.

---

## redis-atomicity-lab

### [redis-A1]
- lab: redis-atomicity-lab
- type: A
- last_asked: —
- q: Flash-sale postmortem: stock=100, 500 concurrent buyers, and the naive GET-then-SET path sold 500 units while the stock key still read ~97. One proposal is to keep the flow but wrap it in WATCH/MULTI. Your harness measured WATCH/MULTI at ~26K aborted transactions and ~1,400 ms — 25× slower than Lua's ~56 ms — for the identical correct result (100 sold, stock 0). Drill the decision.
- ref: The bug is a lost update — buyers read the same stale ~100 and last-writer-wins discards each other's decrements. WATCH/MULTI is correct but optimistic: on a single hot key nearly every EXEC collides, so it degrades into a retry storm (~26K aborts) to reach the same answer. The fitting fix is one atomic check-and-decrement inside Redis (a Lua script, or DECR with a >0 guard/floor) — one round trip, nothing can interleave, correct count AND correct counter. WATCH/MULTI belongs where conflicts are rare (low contention), not a flash sale on one counter.
- grade_note: targets Decision + Tiebreaker (contention level picks the mechanism) + Road Not Taken (Lua single atomic step). Miss = endorsing WATCH/MULTI without the hot-key contention caveat, or not naming lost update.

### [redis-A2]
- lab: redis-atomicity-lab
- type: A
- last_asked: —
- q: The team ships unconditional DECR to stop the oversell. Your harness confirmed exactly 100 buyers saw `remaining >= 0` — but the counter ended at −400, and a later restock of +400 left the shelf reading 0 (still empty to customers). The team declares the fix complete. Drill.
- ref: Atomic on the number ≠ correct system. The gate on `remaining >= 0` gets the sale count right, but the stored counter is polluted to −400, which burns every second reader of that value — restock arithmetic lands wrong, an "items left" display shows nonsense. The complete fix makes the check-and-mutate one atomic step that floors at 0 (Lua / guarded decrement), so the counter itself stays meaningful.
- grade_note: targets Untouched (downstream readers of the stored value) + Decision (floor-at-zero atomic check-and-mutate). Miss = not articulating why −400 matters when the sale count was correct.

### [redis-B1]
- lab: redis-atomicity-lab
- type: B
- last_asked: 2026-07-14
- q: (Predict) The exact same naive GET-then-SET buy code runs with buyers strictly one-at-a-time (serial) instead of in parallel. Stock=100, 500 buyers. Predict units_sold, and state what the result proves about where the bug lives.
- ref: Exactly 100 sold, fully correct — the identical code is safe serially. The bug lives in the gap between GET and SET, and only concurrency opens that gap: parallel buyers read the same stale value inside each other's windows. Concurrency is the trigger, not the code.
- grade_note: essential = correct serial outcome + bug located in the interleaving window, not the logic. Miss = predicting serial oversell, or blaming the code path itself.

### [redis-B2]
- lab: redis-atomicity-lab
- type: B
- last_asked: 2026-07-14
- q: (Explain-mechanism) After the parallel naive run oversells 400 units, the stock key reads ~97 — it barely moved. Walk the mechanism that leaves the counter almost untouched while 5× the stock walks out the door.
- ref: ~All 500 buyers GET the same ~100 before anyone's SET lands, each computes ~99, and each SET overwrites the previous one — last-writer-wins discards the other decrements. So ~500 sales each "decrement once" from the same snapshot, and the final stored value reflects only the last write (~97). The stored number lies because concurrent read-modify-writes don't compose.
- grade_note: essential = concurrent stale reads of the same snapshot + last-writer-wins overwrite discarding decrements. Miss = vague "race condition" without the overwrite step.

### [redis-B3]
- lab: redis-atomicity-lab
- type: B
- last_asked: 2026-07-14
- q: (Boundary) Based on the lab's numbers, state the workload condition under which WATCH/MULTI optimistic locking is a reasonable choice, the condition under which it collapses, and the mechanism that separates the two.
- ref: It's reasonable when conflicts are rare — many keys, low contention — because the abort-and-retry cost scales with collision probability, so aborts stay near zero. It collapses on a single hot key where nearly every EXEC detects a collision: the lab burned ~26K aborted transactions and 25× Lua's latency to reach the identical result. Mechanism: WATCH detects conflicts at EXEC time and retries losers, so total work grows with contention rather than with successful operations.
- grade_note: essential = contention as the boundary variable + abort/retry mechanism + direction (hot key → retry storm). Miss = no contention-based boundary or wrong mechanism.

---

## resilience-patterns-lab

### [resilience-A1]
- lab: resilience-patterns-lab
- type: A
- last_asked: —
- q: Your harness: upstream capacity 30 req/s (concurrencyCap=3 at 100 ms), client rate 20/s, errorRate=0.4, timeout=300 ms. With retries=3 and no backoff, success collapsed to exactly 0 by t≈5 s and never recovered; average offered load including retries was ≈32.5/s. The team proposes adding exponential backoff plus full jitter instead of cutting retries. Which ceiling does that address?
- ref: Not the one that matters. Backoff reschedules WHEN retries fire, not the long-run average attempt volume — 32.5/s still exceeds the 30/s ceiling, so the queue still grows unboundedly and tips (the harness's backoff run collapsed almost identically; jitter only delayed onset from t≈5 to t≈7). Both are timing/synchronization fixes; a structural average-demand-over-capacity deficit needs fewer retries, more capacity, or load shedding.
- grade_note: targets Ceiling (offered-load vs capacity arithmetic survives backoff) + Road Not Taken (shedding / retry budget / capacity). Miss = expecting backoff or jitter to prevent the collapse.

### [resilience-A2]
- lab: resilience-patterns-lab
- type: A
- last_asked: —
- q: Overload run: latency 200 ms, concurrencyCap=5, offered load 40/s. Your harness measured success ≈25/s in BOTH shedMode=queue and shedMode=shed; queue-mode p99 climbed linearly 426 ms→7,383 ms over 20 s while shed-mode p99 held at 201–210 ms. A teammate proposes switching queue→shed "to increase throughput." Drill.
- ref: The throughput ceiling is concurrencyCap ÷ latency = 5 ÷ 0.2 s = 25/s in both modes — shed policy can't move it. The knob only changes the fate of the ~15/s excess: queuing makes every accepted request wait behind an ever-growing line (unbounded linear p99, ~366 ms/s slope), shedding rejects the excess in single-digit ms before it touches the slow path, pinning accepted-work latency at base processing time. The switch buys bounded latency, not throughput.
- grade_note: targets Number/Ceiling (25/s from cap÷latency, mode-independent) + Decision (what shed mode actually buys). Miss = expecting success rate to change with shed mode.

### [resilience-A3]
- lab: resilience-patterns-lab
- type: A
- last_asked: 2026-07-14
- q: Your breaker harness at rate 20/s (a dispatch every 50 ms) against ~20 ms upstream latency showed `breakerHalfOpenProbes=5` behaving identically to `=1`. The team wants to raise the setting to 10 on a service with the same cadence-vs-latency ratio to "recover faster." Drill.
- ref: The knob is silently gated by an unrelated variable: `recordBreakerResult` decides state on the FIRST result to arrive in HALF_OPEN, so extra allowed probes only matter if requests genuinely overlap in flight — and at 50 ms dispatch vs ~20 ms latency, the first probe resolves before the second is dispatched, making the setting inert at any value. Probe cadence is set by breakerOpenMs, and recovery is decided by the probe's real outcome, not by probe count.
- grade_note: targets Untouched (hidden gating variable: request cadence vs upstream latency) + Tiebreaker (what actually controls recovery). Miss = assuming the knob acts as named regardless of relative timing.

### [resilience-B1]
- lab: resilience-patterns-lab
- type: B
- last_asked: 2026-07-16
- q: (Predict) An upstream hangs 30% of requests (accepted, never answered). The client has no timeout, a 10-connection budget, rate 20/s, 20 s run. Ops expects a slow leak — gradual degradation over the run. Predict the actual success curve and give the arithmetic.
- ref: Collapse to success=0 within a few seconds (harness: t=3 s, vs a t=18 s "gradual" prediction — 6× off), then flat zero with no self-recovery. Arithmetic: the hang probability is a per-draw Bernoulli trial over reused sockets, so expected draws-to-hang per socket = 1/p ≈ 3.3 — all 10 sockets are consumed within a couple of socket lifetimes. A hung request without a client timeout is a permanent capacity loss, not a slow leak; a timeout converts it into a fixed-cost retry-the-socket event (stable ~(1−hangProb)×rate).
- grade_note: essential = per-draw hang over reused sockets, 1/p draws-to-hang, fast total collapse + no recovery. Miss = gradual-decay model or expecting self-recovery.

### [resilience-B2]
- lab: resilience-patterns-lab
- type: B
- last_asked: 2026-07-14
- q: (Boundary) An upstream's latency takes exactly two values: 20 ms normally, 300 ms on a spike, spikeProbability=0.5. Compare a client timeout of 150 ms vs 400 ms: what fraction of requests times out in each case, and why is the shape not a dial?
- ref: With a bounded two-value latency profile the timeout is a step function: at 150 ms (below the 300 ms ceiling) every spiked request times out — ~50% of traffic, ~10/s at rate 20 (harness: ~9-10.5/s split); at 400 ms (above the ceiling) exactly zero time out — not "fewer." There is no tail to trade against, so moving the timeout between the two fixed values changes nothing, and crossing the upper value zeroes timeouts instantly.
- grade_note: essential = step function (constant fraction below the ceiling, exactly 0 above) + the bounded-two-value condition that makes it so. Miss = predicting a residual timeout rate above the ceiling.

### [resilience-B3]
- lab: resilience-patterns-lab
- type: B
- last_asked: 2026-07-14
- q: (Explain-mechanism) Circuit breaker: threshold 0.5, window 20, openMs 5000, rate 20/s, against a sustained upstream errorRate=0.6. Describe the long-run state the breaker settles into and the mechanism — then contrast with errorRate=1.0.
- ref: At 0.6 it settles into a metastable oscillation, not a fixed state: the 5 s timer only re-arms a probe OPPORTUNITY; the probe succeeds with P ≈ 1−errorRate = 0.4, and a success fully re-opens the gate (a CLOSED breaker gates nothing) until the fresh window refills (~window/rate ≈ 1 s) and re-crosses the threshold — so it cycles brief-CLOSED / 5s-OPEN, gated by probe luck. At errorRate=1.0 the probe can never succeed, so the oscillation collapses into a permanently re-tripping OPEN state (harness: one probe every 5 s on the dot, 5 attempts, 5 failures, 0 closes). The timer decides opportunity; the probe outcome decides state.
- grade_note: essential = oscillation (not a fixed state) at partial failure, probe-as-coin-flip at 1−errorRate, timer≠recovery, permanent-OPEN at 1.0. Miss = "stays open" at 0.6, or crediting the timer with recovery.

### [resilience-B4]
- lab: resilience-patterns-lab
- type: B
- last_asked: —
- q: (Predict) The oscillating breaker above is running (openMs=5000); at t=15 s the upstream is genuinely fixed (errorRate→0) while the breaker sits mid-OPEN-window, having tripped at t=14. When does the client first notice the recovery, and what bounds that latency in the worst case?
- ref: At the next scheduled probe — t=19 in the harness (5 s after the t=14 trip), after which CLOSED became a true stable fixed point (nothing left to refill the window past threshold). Detection latency = whatever remains of the already-in-flight OPEN timer when the fix lands, NOT a fixed delay from the fix: worst case, a fix landing the instant a fresh OPEN window starts sits undetected for a full breakerOpenMs. The timer bounds probe opportunity symmetrically for lucky probes and genuine recoveries alike.
- grade_note: essential = detection at next probe, latency = residual of in-flight timer, worst case = full openMs, stable CLOSED afterward. Miss = instant detection, or latency measured from the fix.

### [resilience-B5]
- lab: resilience-patterns-lab
- type: B
- last_asked: —
- q: (Spot-the-flaw) After adding retries=3 to clients of a shedding upstream (cap 5, latency 200 ms, offered 40/s), the p99 panel is statistically identical to the no-retry baseline, so a teammate concludes the retries are harmless. Using the lab's counters, what's wrong?
- ref: Success was unchanged (~25/s — capacity-bound, retries can't buy more slots), but total attempts roughly doubled (~40→~85/s) and shed volume roughly quadrupled (~15→~60/s), immediately, for zero benefit — a real regression p99 cannot see because the 99th percentile still falls inside the success cluster. The tell was p50 collapsing from ~200 ms to ~1 ms as near-instant sheds came to dominate the distribution. (Also note the contrast: no storm here, unlike retries against a queueing upstream — sheds resolve too fast for queueing delay to build momentum; it jumps to a worse stable equilibrium instead.) No single percentile proxies health; watch volume/rate metrics alongside latency.
- grade_note: essential = success capacity-bound and unchanged, sent/shed amplification, p50 (not p99) as the tell. Miss = agreeing p99 suffices, or predicting a retry storm/collapse in this setup.

---

## storage-layout-lab

### [storage-A1]
- lab: storage-layout-lab
- type: A
- last_asked: —
- q: Your harness measured ClickHouse row-by-row inserts at 231–397 writes/s vs Postgres 6,726/s and Cassandra ~7,180/s on identical data — with zero errors, and live polling showing background merges kept pace (parts peaked at 38, settled ~10). The team proposes raising insert concurrency from 8 to 64 workers to close the gap. Drill.
- ref: The ceiling is the fixed per-insert cost, not merge pressure and not parallelism: every ClickHouse INSERT creates an on-disk part (directory + column files + fsync), a cost that only amortizes across a batch — the same engine ingested 20M rows in seconds when batched at 50k. ClickHouse write throughput scales with batch size, not concurrency; the fix is batching or a buffer (Kafka) in front. Note the failure is silent: no errors, just ~3% of Postgres's rate.
- grade_note: targets Ceiling (per-insert part-creation cost) + Decision (batch-size lever, not concurrency). Miss = blaming "too many parts"/merges, or expecting concurrency to scale it.

### [storage-A2]
- lab: storage-layout-lab
- type: A
- last_asked: —
- q: Filtering on non-key `user_id` over the same 20M rows: Postgres went 6,692 ms unindexed → 100 ms cold / 4 ms warm after CREATE INDEX; Cassandra refused without ALLOW FILTERING, and WITH it the query failed server-side outright. The team proposes raising Cassandra client timeouts and retrying. Drill.
- ref: Cassandra's per-partition design has no degraded mode for cross-partition scans over ~20M single-row partitions — it fails at its own server-side range timeout, so client-timeout tuning changes nothing (same mechanism that makes an unguarded COUNT(*) fail). The idiomatic escape is a second table organized around the second access path (denormalization), not an index and not retries — or putting that access path on an engine with a post-hoc escape hatch, which is exactly what Postgres's CREATE INDEX is (6.7 s → 4 ms).
- grade_note: targets Decision (server-side failure isn't a client-tuning problem) + Road Not Taken (denormalized second table / different engine). Miss = treating it as a timeout/tuning fix, or expecting a graceful slow mode.

### [storage-A3]
- lab: storage-layout-lab
- type: A
- last_asked: 2026-07-14
- q: Under a 512MB memory cap, your harness saw Postgres run the 20M-row aggregate stably across 3 repeated runs (~4,000–4,500 ms) while ClickHouse OOM-crashed once, then ran fine at the identical, confirmed-still-512MB cap. The team wants to standardize 512MB containers fleet-wide "since both engines passed at least once." Drill.
- ref: Under-provisioning doesn't hit row and column stores symmetrically. Postgres degrades gracefully — small default shared_buffers, spills sorts/merges to disk. ClickHouse assumes a generous baseline memory budget for its own machinery (caches, background merge threads) independent of any single query's footprint, and near that floor it OOMs non-deterministically — not a hard reliable wall, so one clean run is not evidence of safety. The pass/fail asymmetry, not the pass, is the decision input.
- grade_note: targets Tiebreaker (graceful-degradation asymmetry between engines) + Number (non-deterministic OOM at the 512MB floor). Miss = treating a single clean run as clearance, or expecting a deterministic threshold.

### [storage-B1]
- lab: storage-layout-lab
- type: B
- last_asked: —
- q: (Predict) Identical 20M rows in Postgres and ClickHouse; the lab's contract hypothesized ClickHouse would win the SUM…GROUP BY aggregate by >50×. It won by ~14× (415 ms vs 5,871 ms). Explain what sets the actual ratio, and under what schema/cache conditions it would widen toward the hypothesis.
- ref: Columnar wins scale with bytes-of-columns-touched vs whole-row bytes: Postgres drags every ~150–200-byte row off the heap to read ~20 bytes of it, so the gap is set by the wasted-bytes ratio — modest here (~5–10×, narrow schema) — and Postgres claws back further with the page cache and automatic parallel sequential scan. The gap widens with wider rows / fatter payloads or a cold cache.
- grade_note: essential = ratio driven by row width / bytes touched + at least one Postgres mitigation (page cache or parallel scan). Miss = quoting a fixed "columnar is 50–100×" figure with no width/cache condition.

### [storage-B2]
- lab: storage-layout-lab
- type: B
- last_asked: —
- q: (Explain-mechanism) ClickHouse's point lookup on its own ORDER BY key measured 9.9 ms — far slower than Postgres's 1.37 ms B-tree lookup but nowhere near scan-slow. Explain the mechanism that lands it in that middle band.
- ref: A sparse primary index — one entry per 8,192-row granule — is binary-searched to locate the granule, then the whole granule is decompressed and linearly scanned for the row. Work per lookup is bounded (never a full scan) but never an exact jump to the row (never B-tree-fast). No bloom filter is involved unless one is explicitly declared — that was the lab's own wrong guess.
- grade_note: essential = sparse index + granule as the unit of work + bounded-but-not-exact. Miss = bloom filter, or any per-row index model.

### [storage-B3]
- lab: storage-layout-lab
- type: B
- last_asked: —
- q: (Spot-the-flaw) "Cassandra is the write-throughput king, so it should have won the single-node point-lookup test too" — but it came second (3.56 ms) to Postgres (1.37 ms). What's wrong with the expectation?
- ref: On a single node, Cassandra's coordination machinery — consistency-level bookkeeping, CQL framing, and possible multi-SSTable reads left by a bulk load — is pure overhead with nothing to coordinate. Its design buys horizontal scaling (per-lookup cost stays flat as nodes are added), which a single-node benchmark cannot show; Postgres's dense B-tree is purpose-built for exactly this query shape and jumps to the row.
- grade_note: essential = coordination overhead with no payoff on one node + what the design actually buys (horizontal scaling). Miss = generic "LSM reads are slow" with no coordination/single-node reasoning.

### [storage-B4]
- lab: storage-layout-lab
- type: B
- last_asked: —
- q: (Boundary) The same Postgres index on user_id measured a 67× speedup cold (6,692 ms → 100 ms) and ~1,700× warm (→ 4 ms). A teammate wants to record "index = 1,700× faster" in the runbook. What condition is missing, and how should the number be stated?
- ref: The speedup ratio is cache-state-dependent — a 25× swing between cold and warm on the identical index and query. State the mechanism (the index avoids a 6.7 s full scan) with both endpoints, or pin the cache state; a single unconditioned ratio will mislead whoever reads it during an incident with a cold cache.
- grade_note: essential = cache state as the hidden condition + the swing's magnitude direction (warm ≫ cold). Miss = accepting one unconditioned ratio.

---

## streaming-agg-lab

### [streaming-A1]
- lab: streaming-agg-lab
- type: A
- last_asked: 2026-07-17
- q: Your harness injected 10 events timestamped 25 s in the past (watermark delay 2 s): the window count in ClickHouse didn't move, and Flink's `numLateRecordsDropped` rose by exactly 1 — not 10. The team wants to alert on that metric to quantify late-data loss. Drill.
- ref: Late events past the watermark are dropped silently — they never reach the OLAP store, and the drop metric is the ONLY trace. But it counts dropped PARTIALS, not raw events: Flink's two-phase window aggregation (LocalWindowAggregate → GlobalWindowAggregate) pre-combines same-window/same-key records before the late check, so 10 raw events register as 1. The metric is a lower bound / nonzero tripwire, not a loss count — sizing actual loss needs ground-truth reconciliation.
- grade_note: targets Number (the +1 vs +10 mechanism: pre-aggregated partials) + Untouched (metric as lower bound, not a count). Miss = treating the metric as a raw-event loss count.

### [streaming-A2]
- lab: streaming-agg-lab
- type: A
- last_asked: 2026-07-17
- q: To stop late drops the team flips the watermark delay 2 s → 30 s. Your harness confirmed the 25 s-late events then counted — and every window became queryable ~30 s after it ends instead of ~2 s, still emitted exactly once (rows=1). The dashboard's freshness SLA is 10 s. Drill the decision.
- ref: The watermark delay is a completeness↔latency dial: widening it makes late events count, but the window is WITHHELD until the watermark passes end+delay, then emitted once, final — state is held to delay publishing, not to revise a published number. First-order cost is latency (every window now 30 s stale, breaching the 10 s SLA); memory is the second-order cost. The decision must trade measured lateness distribution against the freshness SLA, not just flip the dial to maximum.
- grade_note: targets Decision + Tiebreaker (latency is the first-order cost; withheld-not-revised emission). Miss = believing windows are emitted then revised, or missing the freshness cost.

### [streaming-A3]
- lab: streaming-agg-lab
- type: A
- last_asked: 2026-07-17
- q: After a no-checkpoint restart lost ~4 windows, the team enables 10 s checkpointing plus auto-restart and declares the pipeline exactly-once. Your harness's next TaskManager kill produced no gap — but window 08:15:30 landed in ClickHouse with rows=2 for all 4 event types, total 118 ≈ 2×59. Drill.
- ref: Checkpointing = at-least-once, not exactly-once. It rewinds the source and restores state, so nothing is lost — but any window that fired between the last checkpoint and the crash is recomputed on restore and RE-EMITTED, and a non-idempotent sink writes it twice. Checkpointing protects Flink's state, not the sink. Exactly-once at the store additionally requires an idempotent sink: dedupe on a canonical (window, type) key with durable storage, or upsert/ReplacingMergeTree/transactional writes.
- grade_note: targets Decision (what checkpointing does and doesn't buy) + Untouched (the sink boundary owns delivery semantics). Miss = equating checkpointing with exactly-once, or no sink-side requirement.

### [streaming-B1]
- lab: streaming-agg-lab
- type: B
- last_asked: 2026-07-17
- q: (Predict) Watermark delay is 30 s. An event arrives 25 s late — inside tolerance — for a window whose end time has already passed. Ops expects the already-published ClickHouse row for that window to be updated. What actually happens, and what does `rows` show?
- ref: Nothing gets updated because nothing was published yet: with a 30 s delay the window is withheld until the watermark (max event_time − 30 s) passes the window end, so the late event is folded in before the single, final emission — rows stays 1. Flink holds state to DELAY publishing, not to change a published number.
- grade_note: essential = withheld-then-emit-once (vs emit-then-revise), rows=1. Miss = predicting an update or a second row.

### [streaming-B2]
- lab: streaming-agg-lab
- type: B
- last_asked: 2026-07-17
- q: (Explain-mechanism) A Flink job with checkpointing OFF is cancelled and resubmitted (latest-offset) after ~15 s while the producer keeps writing to Kafka. Afterwards ClickHouse shows a ~4-window hole, and the first post-restart window is partial (3 of 4 event types, total 25 vs ~60). Explain both artifacts.
- ref: Without checkpointing a restart loses both the in-flight window state AND Flink's read position; resubmitting at latest-offset skips every event produced during the outage — the events were durable in Kafka the whole time, but Flink's position was not, so the hole is a permanent under-count proportional to total downtime (detect + decide + redeploy, always longer than the naive estimate). The partial boundary window is the latest-offset mid-window rejoin signature: the job starts consuming partway through a window and only sees its tail.
- grade_note: essential = state AND position lost, latest-offset skipping the outage, loss ∝ total downtime, mid-window rejoin explains the partial. Miss = blaming Kafka for losing data.

### [streaming-B3]
- lab: streaming-agg-lab
- type: B
- last_asked: 2026-07-16
- q: (Spot-the-flaw) A sink dedupes on `(window_start, event_type)` held in an in-memory Set, and the team calls the pipeline exactly-once. Using the two failure modes the lab actually hit, argue where the claim breaks.
- ref: (1) The key must be canonical: a duplicate whose timestamp was formatted `…30.000` instead of `…30` silently defeated the dedupe AND evaded rows>1 duplicate detection — a phantom window_start row that only the cnt=999 sentinel caught. (2) The dedup store must be durable: an in-memory seen set dies with the sink process, so a sink restart re-duplicates. Real exactly-once at the store needs a canonical key plus durable idempotency (upsert / ReplacingMergeTree) or a transactional two-phase-commit sink.
- grade_note: essential = both holes — canonical-key fragility and non-durable dedup state — with their consequences. Miss = either hole absent.

### [streaming-B4]
- lab: streaming-agg-lab
- type: B
- last_asked: 2026-07-17
- q: (Predict) A blast producer outruns Flink's throughput by orders of magnitude for several minutes, then stops. Predict (a) correctness of the window counts, (b) freshness, (c) what happens after the blast stops — and name the one condition under which data is actually lost.
- ref: Backpressure is a freshness failure, not a correctness one: (a) counts stay exact (rows=1, no corruption) because events buffer durably in Kafka and event-time windows don't care when processing happens; (b) freshness falls far behind (harness: ~9 min) and consumer lag grows unbounded; (c) lag drains to 0 and freshness recovers once load subsides. Loss only occurs if Kafka retention expires before the backlog drains (retention < drain time). Watch for partition skew while it drains — the lab's lag piled onto one hot partition (2.6M) while another sat idle, so adding consumers can't speed it past the hottest partition.
- grade_note: essential = correctness preserved / freshness degraded / recovery on subsidence + the retention-vs-drain-time loss condition. Miss = predicting corrupted or permanently lost counts under overload alone.

---

## short-id-lab

### [shortid-A1]
- lab: short-id-lab
- type: A
- last_asked: —
- q: A URL shortener uses random 7-char base62 ids (keyspace 62^7 ≈ 3.5 trillion) with a read-then-insert collision check. A teammate argues "at 3.5 trillion possibilities we won't collide until we've issued hundreds of billions of ids, so the collision check is defensive over-engineering we can drop." Your lab's S3 run put the first collision at draw ~4.5 million. Drill.
- ref: The birthday bound demolishes the "safe until ≈ keyspace" intuition: a collision is ANY pair of issued ids matching, and after n ids there are ≈ n²/2 pairs each colliding with probability 1/D, so expected collisions ≈ n²/2D — reaching 1 at n ≈ √(2D), i.e. first collision at ≈ 1.25·√D, not ≈ D. For 62^7 that's a few million ids (lab: 4,536,737), not hundreds of billions — 5+ orders of magnitude sooner. The check is load-bearing, not defensive; dropping it guarantees silent duplicate ids once traffic reaches √D scale. (Corollary from the S4 control: the same bound proves safety cheaply — at 100k ids, n²/2D ≈ 0.14%, so the failure point is computable, not vague.)
- grade_note: targets Number (√D not D as the collision scale) + Decision (the check is required, not optional). Miss = endorsing "safe until we approach the keyspace," or not naming the pairs/n²-2D mechanism.

### [shortid-A2]
- lab: short-id-lab
- type: A
- last_asked: —
- q: To make random-id inserts safe under load, a service generates a candidate, does `SELECT ... WHERE id = ?` to check it's free, and if free does `INSERT`. Code-reviewed, ships. Your S5 harness ran this at concurrency 50 and the check fired 801 times yet 12 duplicate ids still landed in the table. The team's fix proposal: "add a retry loop around the whole check-then-insert." Drill.
- ref: This is a TOCTOU (time-of-check-to-time-of-use) race and a retry around the same two-step doesn't close it: the SELECT and the INSERT are separate round trips, so two lanes can both SELECT "free" for the same candidate in the gap before either INSERTs — the check is structurally blind to an in-flight insert. Wrapping it in a retry just re-runs the same racy window. The fix moves the uniqueness decision INTO the atomic write: a UNIQUE/PRIMARY KEY constraint, so one insert wins and the other gets a constraint violation to catch-and-regenerate (lab: unique mode = 0 dupes, 14 constraint retries — same races, now visible and safe). The check belongs where the write commits, not in app code before it.
- grade_note: targets Decision (TOCTOU can't be fixed by app-level retry) + Road Not Taken (UNIQUE constraint moves the check into the atomic write). Miss = accepting the read-then-insert-with-retry, or not naming the two-round-trip gap.

### [shortid-A3]
- lab: short-id-lab
- type: A
- last_asked: —
- q: A Snowflake-style id service (ms timestamp | worker id | 12-bit sequence) runs fine for months. An NTP correction steps one node's clock back 100 ms. Your S7 harness reproduced this: the naive generator issued 2,972 duplicate ids from that single rollback. A teammate is surprised — "a 100 ms rollback should at most re-collide one millisecond's worth of ids, maybe a few dozen." Drill the number and the fix.
- ref: The clock steps back and STAYS back, so the generator re-traverses the ENTIRE 100 ms window it already used — not one tick. At the harness's ~50 ids/ms that's ~5,000 ids re-issued at already-visited timestamps, ~2,972 of which exactly reproduce a prior (timestamp, worker, sequence) triple. The "one tick" intuition undercounts by ~60×. The only correct fix is to make the generator refuse to emit while `ts < lastTs` — stall until the wall clock catches back up (lab guard mode: 88 ms stalled, 0 duplicates). Snowflake buys away coordination and the keyspace gamble, but the price is a hard dependency on a monotonic clock; non-monotonicity (NTP steps, VM live-migration, leap-second smear) must halt generation, not proceed.
- grade_note: targets Number (rollback re-traverses the whole held window, not one tick — ~60× undercount) + Decision (stall-on-regression is the only safe response). Miss = accepting "a few dozen," or a fix that keeps emitting through the rollback.

### [shortid-B1]
- lab: short-id-lab
- type: B
- last_asked: —
- q: (Predict) Random base62 ids are drawn uniformly, one at a time, into a set until the first repeat. Predict the order of magnitude of the draw number at which the first collision appears, for a keyspace of size D — and state the rule. Then apply it: 62^5 ≈ 916M, 62^6 ≈ 56.8B, 62^7 ≈ 3.5T.
- ref: First collision at ≈ 1.25·√D (birthday bound), NOT near D — collisions accumulate by pairs (≈ n²/2 pairs after n draws, each matching with prob 1/D, so expected collisions ≈ n²/2D, hitting 1 at n ≈ √(2D)). So: 62^5 → ~35k (lab: 8.6k–70k across 9 trials); 62^6 → ~300k (lab: 402,292); 62^7 → ~2.35M mean (lab single trial: 4,536,737, within normal tail variance — the distribution is wide). The naive "safe until draws ≈ D" rule overestimates by ~√D, i.e. 4–5 orders of magnitude here.
- grade_note: essential = ≈√D scale (not D) + the pairs/n²-2D mechanism + roughly correct per-length magnitudes. Miss = predicting collisions near D, or no pairs-based reasoning.

### [shortid-B2]
- lab: short-id-lab
- type: B
- last_asked: —
- q: (Boundary) A single-worker Snowflake generator has a 12-bit per-ms sequence (4,096 ids/ms ceiling) and runs on a box that generates ~1.86M simple ids/s. Predict the max ids that actually land in any one millisecond when generating 50k ids flat-out, and whether the total wall time is set by the sequence ceiling or by something else.
- ref: The 4,096/ms ceiling is only reached if the generator can produce >4.096M ids/s; at ~1.86M/s it emits only ~1,862 ids per ms, well under the ceiling — so most milliseconds never fill, and the ceiling is NOT the binding constraint (lab: max 4,096/ms was hit in only 6 of 20 ms buckets). Wall time is set by generator THROUGHPUT (CPU-bound, ~1.86M/s → 26.8 ms for 50k), roughly 2× the naive "50k ÷ 4,096 = 13 ms" ceiling estimate. The sequence ceiling is a floor on time; real single-process throughput binds first.
- grade_note: essential = actual per-ms count set by throughput (~1,862) not the 4,096 ceiling + wall time bound by throughput, ceiling is only a floor. Miss = assuming every ms fills to 4,096, or that the sequence ceiling sets the wall time.

### [shortid-B3]
- lab: short-id-lab
- type: B
- last_asked: —
- q: (Explain-mechanism) A URL shortener uses a sequential base62 counter (aaaaaaa, aaaaaab, ...). Single-process it produces 100k perfectly-unique ids in ~10 ms with zero collisions. Explain why this scheme, despite flawless uniqueness and speed, is unsafe for public short links — and separately why it breaks the moment you run two generators.
- ref: Two independent failures. (1) Enumerability/leakage: the id IS the sequence number, so anyone holding one id can compute the exact next and previous ids (lab: from `aaaajMW`, predicted next/prev both matched) AND read the total volume issued off any single id (its own sequence number, 37,001) — a competitor scrapes every link ever issued and reads your growth rate from one link. (2) Coordination: uniqueness lives in one shared counter, so two uncoordinated generators each replay the identical sequence from aaaaaaa (lab: 15,000 dupes in 20,000 = 75%); fixing it needs one atomic counter (a serialized disk-backed round trip per id), which cut throughput ~700× (10M/s → 14.6k/s). The counter's guarantee lives in a single coordination point you pay for on every id.
- grade_note: essential = enumerability/volume-leak (id = sequence number) + the two-generator collision needing a single coordination point at a throughput cost. Miss = citing only one of the two failures, or treating single-process uniqueness as sufficient for public ids.

---

## workload-bounds

### [workload-A1]
- lab: workload-bounds
- type: A
- last_asked: —
- q: A single-threaded service doing 4K writes with fsync-per-write on an 8-core box. Your harness showed us≈0, iowait≈10, %util 70–79, ~2,100 writes/s. A teammate reads "iowait only 10%" off the graph, rules out disk, and proposes CPU-profiling the app. Drill the number.
- ref: wa is a percentage of TOTAL CPU capacity, so its ceiling is blocked-threads ÷ cores — one blocked thread on 8 cores caps it at 12.5%. A reading of 10 is therefore near-maximal: this box is screaming disk-bound, and the same service on 32 cores would show wa≈3. The reliable disk-bound signature is b>0 persistently + a busy device + us≈0, never a big wa. The ~2,100 writes/s ceiling is the fsync round-trip itself (~0.5 ms on NVMe-backed storage, not the 10 ms spinning-rust number).
- grade_note: targets Number (the blocked-threads/cores wa arithmetic) + Ceiling (fsync round-trip sets ~2k/s). Miss = reading wa as an absolute disk-saturation gauge.

### [workload-A2]
- lab: workload-bounds
- type: A
- last_asked: —
- q: An app is pinned flat at 190 Mbit/s through a 200 Mbit tc cap with zero retransmits, while vmstat shows id 99–100 and iostat is silent — the box looks perfectly healthy. The team proposes a bigger instance with more cores. Drill.
- ref: This is the invisible bound: the sender blocks in send() when the socket buffer fills (flow-control backpressure), and waiting on the network is counted as plain IDLE — vmstat has no network-wait column, and wa is disk-only. More cores change nothing; the ceiling is the 200 Mbit cap. Diagnose by elimination (CPU, disk, memory all quiet + app pinned at a ceiling) and confirm with network-side instruments: iperf/iftop/socket stats/retransmits. (sy would only climb in the UNcapped case, where multi-Gbit through the stack costs real CPU.)
- grade_note: targets Ceiling (the network cap, invisible in host CPU columns) + Road Not Taken (network-side instrumentation / diagnosis by elimination). Miss = not knowing network wait lands in idle.

### [workload-A3]
- lab: workload-bounds
- type: A
- last_asked: —
- q: During the fsync scenario, iostat showed the device at %util 70–79, and a teammate concludes the disk "has 25% headroom" so it can't be the bottleneck. Drill the number.
- ref: %util is the fraction of time the device has ≥1 request in flight — not capacity consumed. A single-threaded synchronous writer leaves gaps between requests (compute the next write, syscall overhead), so the device can be the hard bottleneck well below 100%. Corroborate with b>0, us≈0, and writes/s against the fsync round-trip budget (~0.5 ms → ~2k/s) — that arithmetic, not %util, says whether the device is the limit. (Bonus signal from the same run: 6× write amplification — the app wrote 8.7 MB/s while the device took ~50 MB/s of journal+metadata.)
- grade_note: targets Number (what %util actually measures) + Tiebreaker (the fsync-budget arithmetic as the deciding instrument). Miss = treating %util as fraction-of-capacity.

### [workload-B1]
- lab: workload-bounds
- type: B
- last_asked: —
- q: (Predict) The same 4K-write workload is re-run without fsync. Ops expects the disk bottleneck to disappear since writes now land in memory. Describe the throughput shape over a minute and state what sets the sustained average.
- ref: A violent sawtooth — the harness oscillated 35k↔1.26M writes/s with one 1-second sample of 28 — because the page cache absorbs writes at memory speed only until dirty pages cross dirty_ratio, at which point the kernel's writeback throttling (balance_dirty_pages) puts the writer to sleep INSIDE write() until flushers drain. The sustained average is still disk speed: memory sets the burst length, the device sets the mean. Side signature: wa can exceed the single-thread 12.5% cap (hit 37) because kworker flusher threads block on the device too (b=3), plus giant bo bursts and a deep queue (aqu-sz in the hundreds, w_await 1–2 s).
- grade_note: essential = dirty_ratio/writeback-throttling mechanism, sawtooth shape, disk-sets-the-mean. Miss = "memory-bound now" or a smooth fast curve.

### [workload-B2]
- lab: workload-bounds
- type: B
- last_asked: —
- q: (Explain-mechanism) A process with a 768 MB working set inside a 512 MB-limit container (plus 512 MB swap) sees its memory-touch rate collapse from >1M/s to ~25k/s, with vmstat showing si/so sustained at 26–38k KB/s and the CPU ~88% idle. Walk the per-touch mechanism producing the ~40× collapse, and say where the lost time shows up in the CPU columns.
- ref: Each touch of a swapped page is a major fault: trap → kernel reads the 4 KB page from swap ON DISK (~0.1–1 ms) → the process SLEEPS → often another page must be evicted (written out) first → resume. An in-RAM touch is nanoseconds, a swapped touch is milliseconds — the mix collapses the average ~40×; "heavy swap traffic" and "memory-speed access" are mutually exclusive, the traffic IS the collapse. The wait lands in wa (capped again at 12.5% by the one-thread/8-core arithmetic), NOT sy — kernel CPU work per fault is tiny. bi/bo mirror si/so because swap IS disk: thrashing converts memory ops into disk ops (distinguisher from plain disk-bound: the I/O shows in si/so and the process issues no file I/O).
- grade_note: essential = major-fault-sleeps-on-disk-read mechanism, wa-not-sy attribution, swap-is-disk (si/so mirrored in bi/bo). Miss = expecting high sy or high CPU, or no disk round trip in the story.

### [workload-B3]
- lab: workload-bounds
- type: B
- last_asked: —
- q: (Boundary) vmstat's r column reads 8 on an 8-core box running a tight hash loop; on another day a different workload shows r=40 on the same box. What does each reading tell you, and where is the boundary?
- ref: r counts RUNNABLE processes — running PLUS queued, not just queued (8 burners on 8 cores → r=8 with zero queue). The boundary is the core count: r ≈ cores means the CPU is saturated but keeping up; r ≫ cores means contention/queueing — work waiting for a core — which is the actual overload signal. r=40 on 8 cores is 32 runnables waiting per tick.
- grade_note: essential = r includes running (not queue-only) + the r-vs-core-count boundary between saturated and contended. Miss = reading r as a pure wait queue.

---

## temporal-durable-execution-lab

### [temporal-A1]
- lab: temporal-durable-execution-lab
- type: A
- last_asked: —
- q: An order service runs reserve → charge → ship and persists a `status` column, with a supervisor that re-runs any order not SHIPPED. After a deploy, ~1 in 500 orders is double-charged. A teammate proposes "the supervisor is too aggressive — add a 30-second delay before it retries, that'll give the first attempt time to finish." Drill.
- ref: The delay treats a timing symptom of a structural bug. The double charge happens when the process dies in the window between the charge side effect (money moved) and the `status=CHARGED` write — the two are not atomic, so status lags reality by one step. On resume the supervisor reads `status=RESERVED` and re-charges. A delay changes WHEN the retry runs, not WHAT it finds: whenever a crash lands in that window (crash timing is not under your control), the retry still sees stale status and re-charges. Real fixes change the shape: record each step's RESULT to a durable log and replay/skip completed steps (durable execution), and/or make the charge idempotent (idempotency key) so a re-run is a no-op. Ties to dist-txn-A1 (blind retry can't tell which half already happened).
- grade_note: targets Decision (delay addresses timing not the non-atomic status/side-effect gap) + Road Not Taken (event-log replay and/or idempotency key). Miss = endorsing the delay, or a fix that doesn't address stale status on resume.

### [temporal-A2]
- lab: temporal-durable-execution-lab
- type: A
- last_asked: —
- q: After adopting a durable-execution engine (Temporal-style: append-only history + replay), a team declares "charges can never double now — the engine guarantees exactly-once." Their payment activity has no idempotency key. Using the lab's S5, what's wrong with "exactly-once"?
- ref: The engine guarantees at-least-once step execution + deterministic replay of RECORDED results, not exactly-once side effects. There is a window between "the activity's side effect hit the world" and "the activity's result was appended to history" — a crash there leaves history with no record of the charge, so on replay the engine finds nothing recorded for that step and re-executes it (the lab's S5: crash at charge-side → 2 charges, charge shows `[exec]`). History is the only thing replay trusts; if the world changed but history didn't, the step re-runs. Exactly-once external effects require the engine's at-least-once PLUS an idempotent activity (idempotency key) so the second call no-ops (S5-fix → 1 charge).
- grade_note: targets Decision (engine = at-least-once, not exactly-once) + mechanism (side-effect-before-history-write window re-runs on replay; idempotency key closes it). Miss = accepting "exactly-once" from the engine alone, or not naming the record-after-side-effect window.

### [temporal-B1]
- lab: temporal-durable-execution-lab
- type: B
- last_asked: —
- q: (Naive-vs-fixed) A workflow does reserve → charge → ship. State what goes wrong when the process is killed BETWEEN the charge side effect and the persistence of progress in (a) the naive `status`-column version, and (b) a durable-execution engine where the crash lands after the charge result is appended to history — and name the mechanism that makes (b) safe.
- ref: (a) Naive: the charge hit the world but `status` is still RESERVED (the side effect and the status write are separate, non-atomic writes); the supervisor re-reads status and re-charges → double charge (lab S2). (b) Durable, crash after the history append: on restart the workflow re-runs from the top, but when it reaches the charge step the engine finds the recorded result in history and REPLAYS it — returns the stored value, does not re-run the side effect — then continues at ship → 1 charge (lab S2'). The mechanism is event-sourced replay: each step's result is a durable event, and a recorded step is replayed (not recomputed, not re-executed) on restart.
- grade_note: essential = naive double-charge from non-atomic status-vs-side-effect + durable replay returns recorded result / skips the step. Miss = describing the fix as "it retries better" without the record-and-replay mechanism, or missing that replay returns the stored result rather than recomputing.

### [temporal-B2]
- lab: temporal-durable-execution-lab
- type: B
- last_asked: —
- q: (Explain-mechanism) In a durable-execution engine, a workflow computes a promo price at the start. Explain why, on replay after a crash, the price is NOT recomputed — and what would break if the engine recomputed it instead of reading it back.
- ref: The price is computed inside a STEP, so its result was appended to history as a durable event the first time it ran. On restart the engine re-runs the workflow body but, reaching that step, returns the RECORDED value from history — replay reconstructs in-memory state by replaying results, not by re-executing the logic. If the engine recomputed it (the price function uses a varying promo / randomness), replay would produce a DIFFERENT value than the original run, so the workflow would continue from a state inconsistent with what already happened in the world (e.g. charge at a price different from the one recorded/quoted) — this is exactly the naive bug (lab S4: two charges at different prices) and the general non-determinism hazard: anything non-deterministic must be captured as a recorded step, never re-derived on replay.
- grade_note: essential = step result recorded in history + replay returns the recorded value (not recompute) + recompute would diverge → inconsistent-with-world state. Miss = thinking replay re-runs the computation, or not connecting divergence to correctness.

### [temporal-B3]
- lab: temporal-durable-execution-lab
- type: B
- last_asked: —
- q: (Boundary) Name a failure that durable execution does NOT protect against, and state the rule that prevents it. Be specific about where the offending code lives.
- ref: Two boundaries. (1) At-least-once side effects: a crash between the side effect and the history write re-runs the step on replay (the engine can't know an external system already acted) — the fix is an idempotent activity / idempotency key, which lives OUTSIDE the engine's guarantee. (2) Non-determinism in ORCHESTRATION (workflow-body) code: replay re-executes the body, so a branch on Math.random()/Date.now()/wall-clock/map-order that is NOT inside a recorded step can take a different path on replay than originally ran → recorded history no longer matches the code's actions → non-determinism error/corruption. The rule: all non-determinism and all side effects must live inside steps/activities (whose results are recorded and replayed), never in the orchestration code; and side effects that must be exactly-once need their own idempotency on top of the engine's at-least-once.
- grade_note: essential = names at least one true boundary (at-least-once side effects OR non-determinism in workflow body) with its rule (idempotency key / "non-determinism goes inside an activity"). Miss = claiming durable execution makes side effects exactly-once by itself, or putting non-deterministic reads in orchestration code.

---

## Uncovered labs

- **streaming-agg-lab/topk** (Top-K rollup sub-lab): harness built and smoke-tested, README and PLAN.md exist, but no WHY.md / failure matrix yet — Phase 2 scenarios haven't been run. No questions generated; add `topk-A*/B*` entries here once its WHY.md lands.

All eleven top-level lab folders (dist-txn-lab, model-routing-lab, page-cache-lab, partition-skew-lab, redis-atomicity-lab, resilience-patterns-lab, short-id-lab, storage-layout-lab, streaming-agg-lab, temporal-durable-execution-lab, workload-bounds) have a why-doc and scenario matrix and are covered above.
