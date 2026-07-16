# WHY — atomic commitment: naive dual-write vs 2PC vs saga

## The observable claim

When one business action must write to two independent databases, no ordering of
plain commits makes the pair atomic — and the two fixes each pay a watchable price:
2PC buys atomicity with **blocking**, sagas buy availability with **lost isolation**.

## What the experiments showed

**The need (S1).** A crash between two independent commits left 100 permanently
missing (1900), and the "obvious" operator retry made it *worse* (double-debit,
still 1900): a retry cannot know which half already happened. Atomicity across
two databases cannot be assembled from two local atomicities plus care.

**How 2PC actually works (S2–S5).** The protocol's essence is two durable writes
that change who is allowed to decide:

1. `PREPARE TRANSACTION` is a **WAL write on the participant** (`pg_twophase`):
   the txn's full state persists before the YES answer, which is why S5's prepared
   txn sailed through a container restart with its age ticking uninterrupted.
   A YES vote is a durable promise — the participant gives up its right to decide.
2. The **decision record on the coordinator's disk is the commit point** — not any
   participant's commit. S3 and S4 were byte-identical from the participants' view;
   one JSON line flipped the global outcome from abort (presumed, no decision on
   record) to commit (roll forward). "Commit" in 2PC means "the decision is durable
   at the coordinator."

**The price (S3).** Between YES and the decision, a participant is **in-doubt**:
it can neither commit nor abort alone, holds row locks **unbounded** (no timeout,
no vacuum relief, survives restarts), and blocks every writer that needs those rows
— our contender burned its full 5s lock_timeout and gave up. Readers were unharmed
(MVCC serves the pre-txn version); in-doubt blocking is a *writer* problem. This
unbounded-quiet-damage failure mode is why Postgres ships `max_prepared_transactions=0`
(S2): 2PC is opt-in because an orphaned prepare with no coordinator to resolve it
is worse than no 2PC at all.

**The saga trade (S6–S7).** Every saga step is a local, immediately-visible commit;
"abort" is not an undo but **new compensating transactions** — S6 left two committed
txns on bank-a netting to zero, where 2PC's abort left zero history. Consequence,
watched live in S7: ~15 seconds of `TOTAL=1900, invariant VIOLATED` visible to every
reader, writers proceeding in 2–4 ms (no locks held between steps — the blocking is
gone, that's the availability win), and any decision made on the window's state
(declining alice's 1000-unit debit for "insufficient funds") silently becomes wrong
when compensation lands. The anomaly leaves **no marker**: window state is real
committed state, indistinguishable after the fact.

## Reproduce cold (interview sentences)

- "Two independent commits can never be atomic — a crash between them loses money,
  and a retry can't fix it because it can't know which half already happened; that's
  the problem both 2PC and sagas exist to solve."
- "2PC's commit point is a log write on the coordinator; a participant that voted YES
  has durably given up the right to decide, so if the coordinator vanishes it sits
  in-doubt holding locks unbounded — atomic, but blocking."
- "A saga replaces the distributed transaction with a chain of local commits plus
  compensations, so nothing ever blocks — but every intermediate state is real,
  visible, committed data, and compensation is a new transaction, not an undo:
  sagas trade isolation for availability."

## Parking lot (seeds for future labs, not chased here)

- **Idempotency keys / step registry** — the real fix for S1's double-debit retry
  (each transfer step records a txn-id so a retry becomes a no-op). Ties directly to
  the streaming-lab dedupe findings (canonical key + durable store).
- **Coordinator as SPOF** — our recovery required the coordinator's log to survive.
  Replicating the decision (Paxos-commit / XA with an HA transaction manager) is the
  next rung of 2PC.
- **Heuristic resolution** — operators force-resolving in-doubt txns without the
  coordinator log (XA "heuristic commit/rollback") and the atomicity violations that
  causes (imagine ROLLBACK PREPARED in S4's state).
- **Saga isolation countermeasures** — semantic locks / pending states
  (`balance_pending` columns), commutative updates, versioned reads.
- **Choreography sagas over a broker** — event-driven compensation, where the
  orchestrator itself can crash mid-saga (needs its own durable saga log — note the
  symmetry with the 2PC coordinator log).
