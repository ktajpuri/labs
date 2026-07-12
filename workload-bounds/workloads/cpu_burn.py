#!/usr/bin/env python3
"""CPU-bound workload: tight sha256 loop, one process per core.

Prints aggregate hash ops/sec once per second. Nothing else — no IO, no
allocation beyond a 64-byte buffer per worker.
"""
import argparse
import hashlib
import multiprocessing as mp
import os
import time

BATCH = 20_000


def burn(counter):
    buf = b"x" * 64
    sha = hashlib.sha256
    while True:
        for _ in range(BATCH):
            buf = sha(buf).digest() * 2
        with counter.get_lock():
            counter.value += BATCH


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=os.cpu_count(),
                    help="burner processes (default: all cores)")
    args = ap.parse_args()

    counter = mp.Value("q", 0)
    for _ in range(args.workers):
        mp.Process(target=burn, args=(counter,), daemon=True).start()

    print(f"burning on {args.workers} workers (Ctrl-C to stop)", flush=True)
    prev, prev_t = 0, time.monotonic()
    while True:
        time.sleep(1)
        now, now_t = counter.value, time.monotonic()
        rate = (now - prev) / (now_t - prev_t)
        print(f"{rate/1e6:8.2f} M hash-ops/sec", flush=True)
        prev, prev_t = now, now_t


if __name__ == "__main__":
    main()
