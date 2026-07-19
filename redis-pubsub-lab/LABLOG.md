# LABLOG — Redis Pub/Sub Delivery Semantics (DISCOVERY)

Session: 2026-07-19. Mode: DISCOVERY. Steady state verified (sub-first, 5 msgs, 0 gaps, delivered_to=1).

Format: ✓ diagnosis/prediction = one line. ✗/partial = full entry (verbatim statement,
attempted derivation, correction, one "keep" sentence).

---

## Phase 2a — breaking naive Pub/Sub (diagnose-first)

<!-- entries appended per scenario at the compare step -->

**S1 — publish into empty room (no subscriber), then late subscriber joins.** ✓
Observed: publisher `delivered_to=0` ×10 (received-by-0 = 10); late subscriber received 0, sits forever. Diagnosis (verbatim): "1. It doesnt have capability to store messages. Clients cant request past messages on connecting. 2. redis just works like a proxy here for messages and the connections details are whats actually stored. A message comes redis just sends it to connected subscribers, no storage." Correct — subscription table (channel→connections), PUBLISH walks it and discards; message lifetime = duration of the PUBLISH call. At-most-once, no durability/replay.

**S2 — late joiner mid-stream (publish 20 @500ms, subscribe ~seq 16).** ✓
Observed: publisher `delivered_to` flips 0→1 at exactly seq 16; subscriber first=16 last=20 received=5 gaps=none. Diagnosis (verbatim): "1. first seq seen is 16. It gets the message sent right after the connection is established. 2. there wont be gaps inside the range it received. After it joins its just a normal subscriber, no special case." Correct — boundary = SUBSCRIBE completing (added to subscription table); clean prefix-loss + perfect suffix = join-time loss, not random drop. This is exactly what his WS app's DB + init payload compensated for.

**S3 — transient blip on an ESTABLISHED subscriber (connected from seq 1, drop at 5 for 2s).** ✓ (mechanism); count off by 1 (timing, pre-warned)
Prediction (verbatim): "1) received 1-5, then gap, then 10-20. Messages 6,7,8,9 are missed, 4 messages in 2 sec time. 2) those messages are nuked into oblivion, received by nobody. They cant get delivered because redis doesnt have them, it doesnt store them." Observed: gaps = 6,7,8 (three lost, not four — reconnect SUBSCRIBE landed just before seq 9). Publisher independently showed delivered_to=0 only at 6,7,8. Shape + mechanism exactly right; the 4-vs-3 count is timing jitter (boundaries flagged as timing-dependent up front), not a conceptual miss. Keep: a healthy, established subscriber still permanently loses every message published during any disconnect window — no re-sync exists in Pub/Sub.

**S4 — two subscribers, both connected (fan-out control, no failure injected).** ✓
Prediction (verbatim): "1. each receives 10 messages. 2) delivered_to shows 2. total deliveries / avg receivers = 10" (the "=10" was a slip; corrected to total=20/avg=2 before running). Observed: both subs received 10/10 gaps none; delivered_to=2 all msgs; total=20 avg=2.00. Correct — Pub/Sub is a BROADCAST bus (fan-out to every subscribed connection), NOT a work queue (no load-balancing). This is the cross-instance fan-out that justifies Redis behind multiple WS server instances.

---

## Phase 2b — same scenarios with the fix (Redis Streams + consumer group), predict-first

**S1′ — publish 10 into empty room, consume later (group cg1 from 0).** ✓
Prediction (verbatim): "late-starting consumer receives 10 messages, no gaps." Observed: received 10, distinct 10, duplicates 0, gaps none. Naive-vs-fixed: S1=0 received → S1'=10. Durable log (XADD) + group position (IDs like 1784446776458-0) = replay from 0.

**S2′ — late joiner (publish 20 @500ms, consumer starts ~3s late), group cg1 from 0.** ✓
Prediction (verbatim): "first seq seen=1, received=20, gaps none. The moment it joins all previous messages get dumped and then it receives the messages as they are published." Observed: first=1, received=20, distinct=20, gaps none. Naive-vs-fixed: S2 first=16 (lost 1-15) → S2' first=1 (all recovered). Boundary moved from connect-time to group position (=0).

**S3′ — transient blip on established consumer (blip at seq 5 for 3s, producer @500ms), group cg1.** ✓
Prediction (verbatim): "1. no gaps, no duplicates (not 100% sure — could be 1 duplicate depending on exact blip time). 2. those 6 messages are stored in redis, resume from last received position." Observed: received 20, distinct 20, duplicates 0, gaps none. Seq 6–11 appended during the 3s outage stayed undelivered in the log; XREADGROUP > delivered them on reconnect. Naive-vs-fixed: S3 gaps 6,7,8 permanent → S3' gaps none. Duplicate instinct correct: 0 here because ack precedes the drop — the pre/post-ack seam is the at-least-once boundary (see S4').

**S4′ — two consumers in the SAME group cg1 (boundary: group = work queue, not broadcast).** ✓
Prediction (verbatim): "1. They both get around 10 messages each. 2. total is 20. 3. consumer group is like a work queue, each message handled once. It does [hold as durable pub/sub] if I consider consumers in 1 consumer group as parallel processing for same consumer." Observed: c1 got evens (2,4,...,20), c2 got odds (1,3,...,19), each distinct=10, 0 overlap, total 20. Correctly rejected "durable Pub/Sub = broadcast." Naive-vs-fixed: S4 both subs got all 10 (broadcast) → S4' one shared group SPLITS. Consequence: fan-out + durability requires ONE GROUP PER CONSUMER; a shared group is competing-consumers load-balancing.

**S5 (bonus boundary) — at-least-once: crash-before-ack=3, then restart with --reclaim.** partial (core ✓, batch-delivery nuance missed) — THE boundary the fix does not solve.
Prediction (verbatim): "1) 1,2 ackd, 3 is pending. 4 5 never delivered. 2) 3 gets processed second time. It was not ackd. 3) double charge, consumer needs to be idempotent."
Attempted derivation of gap: he modeled delivery as per-message at processing time, so expected only seq 3 stranded and 4/5 untouched.
Correction: XREADGROUP COUNT 10 prefetches a BATCH — run 1's first read moved seqs 1–5 into c1's Pending Entries List at once; it processed/acked 1,2, processed-but-didn't-ack 3 (crash), and 4,5 sat in the PEL delivered-but-never-processed. On --reclaim, XREADGROUP 0 returned 3,4,5 as pending. So seq 3 = a true double-process (printed in run 1 AND run 2) = at-least-once duplicate; "delivered" in a consumer group means "assigned to a consumer's PEL," NOT "handled." The per-process duplicates counter shows 0 because it can't see across the crash boundary.
Keep: Redis Streams are AT-LEAST-ONCE — a crash after processing but before XACK leaves the entry in the PEL and it is redelivered on recovery; batch COUNT can strand several unprocessed entries at once; the ONLY thing that makes redelivery safe is an idempotent consumer (idempotency key), which lives OUTSIDE Redis's guarantee. Same boundary as durable-execution engines (Temporal warm-up).
