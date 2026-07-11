# partition-skew-lab

Concept: partition skew sets a ceiling consumer scaling cannot break through.
An uneven key distribution creates a hot partition, and since Kafka never
assigns more than one consumer-per-partition within a group, that hot
partition's single consumer bounds total throughput — no matter how many
consumers or partitions you add — unless you fix the key distribution itself.

No stream processor, no sink. Everything observable lives at the Kafka
partition / consumer-group layer, watched live through `monitor/lag.js`.

## Start

```
docker compose up -d
npm install
npm run topic:create        # creates 'events' with 4 partitions
```

## Reset to clean state

```
npm run topic:create         # deletes + recreates the topic (wipes all data + consumer group offsets)
```

or tear down entirely:

```
docker compose down          # no volumes are mounted, so this is already a full wipe
```

## Steady-state check (run this before any scenario)

Three terminals:

```
# terminal 1
npm run monitor

# terminal 2
npm run consume -- --count 4 --work-ms 10

# terminal 3
npm run produce -- --keys uniform --rate 200
```

Each consumer can process ~100 msg/s (`work-ms 10`). Uniform keys spread
~200/s evenly across 4 partitions (~50/s each), so with one consumer per
partition every partition's lag should stay near 0 and `msgs/sec` in the
monitor should hover around 50 per partition. Confirm this looks stable for
~30s before moving to any failure scenario — Ctrl-C the producer and consumer
when done, then `npm run topic:create` to reset before scenario 1.

## Key strategies (producer `--keys` flag)

- `uniform` — high-cardinality random keys, spreads evenly by hash.
- `skewed` — ~90% of traffic uses a single key (`hot`), the rest spread over 3 cold keys.
- `salted` — same as skewed, but the hot key is suffixed with a random bucket (`--salt N`, default 8) so it fans out across up to N sub-keys instead of piling onto one.

## Scaling consumers mid-run

`consumer/consume.js` spins up N consumer instances inside one process. To
add MORE consumers to an already-running group in a second terminal without
clientId collisions in the logs, use `--id-offset`:

```
npm run consume -- --count 1 --work-ms 10 --id-offset 4    # becomes consumer-5
```

## Growing partitions mid-run

```
npm run topic:grow                        # 4 -> 8 partitions, default
node scripts/topic.js grow --partitions N # custom count
```

This does NOT delete or move any existing data — only future produces are
affected by the new partition count. That distinction is the point of
scenario 5.
