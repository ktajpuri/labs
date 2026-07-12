#!/usr/bin/env python3
"""Memory-capacity workload: allocate a working set bigger than the container's
memory limit, then touch pages at random forever.

Container is capped at 512 MB RAM + 512 MB swap (see docker-compose.yml).
Default working set is 768 MB, so ~256 MB must live in swap at any moment.

Prints page-touches/sec once per second. Two possible fates:
  - thrash: rate collapses, vmstat shows si/so storms
  - OOM-kill: process dies, shell shows exit code 137
"""
import argparse
import random
import time

CHUNK_MB = 32
PAGE = 4096


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--size-mb", type=int, default=768)
    ap.add_argument("--touches-per-round", type=int, default=2000)
    args = ap.parse_args()

    nchunks = args.size_mb // CHUNK_MB
    chunks = []
    print(f"allocating {nchunks * CHUNK_MB} MB in {CHUNK_MB} MB chunks...", flush=True)
    for i in range(nchunks):
        c = bytearray(CHUNK_MB * 1024 * 1024)
        for off in range(0, len(c), PAGE):   # touch every page so it's really resident
            c[off] = 1
        chunks.append(c)
        if (i + 1) % 8 == 0:
            print(f"  {(i + 1) * CHUNK_MB} MB allocated", flush=True)

    print("allocation done — thrashing (Ctrl-C to stop)", flush=True)
    touches = 0
    prev, prev_t = 0, time.monotonic()
    chunk_len = CHUNK_MB * 1024 * 1024
    while True:
        c = chunks[random.randrange(nchunks)]
        for _ in range(args.touches_per_round):
            c[random.randrange(chunk_len)] = 2
        touches += args.touches_per_round
        now_t = time.monotonic()
        if now_t - prev_t >= 1.0:
            rate = (touches - prev) / (now_t - prev_t)
            print(f"{rate:12.0f} page-touches/sec", flush=True)
            prev, prev_t = touches, now_t


if __name__ == "__main__":
    main()
