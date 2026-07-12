#!/usr/bin/env python3
"""Disk workload: sequential 4 KB writes to a file, wrapping at --file-size-mb.

--fsync (default):   fsync after EVERY write  -> each write must reach the device
--no-fsync:          plain writes             -> page cache absorbs them

Same code path either way; prints writes/sec + MB/s once per second.
Used by scenarios 2 (fsync, /data), 3 (no-fsync, /data), 6 (fsync, /ramdata).
"""
import argparse
import os
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--path", default="/data/testfile")
    ap.add_argument("--fsync", action=argparse.BooleanOptionalAction, default=True)
    ap.add_argument("--file-size-mb", type=int, default=1024)
    ap.add_argument("--block-kb", type=int, default=4)
    args = ap.parse_args()

    block = os.urandom(args.block_kb * 1024)
    wrap = args.file_size_mb * 1024 * 1024
    fd = os.open(args.path, os.O_WRONLY | os.O_CREAT, 0o644)

    mode = "fsync-per-write" if args.fsync else "buffered (no fsync)"
    print(f"writing {args.block_kb}K blocks to {args.path}, {mode}", flush=True)

    pos = 0
    writes = 0
    prev, prev_t = 0, time.monotonic()
    try:
        while True:
            os.write(fd, block)
            if args.fsync:
                os.fsync(fd)
            writes += 1
            pos += len(block)
            if pos >= wrap:
                pos = 0
                os.lseek(fd, 0, os.SEEK_SET)
            now_t = time.monotonic()
            if now_t - prev_t >= 1.0:
                rate = (writes - prev) / (now_t - prev_t)
                print(f"{rate:10.0f} writes/sec  {rate*len(block)/1e6:8.1f} MB/s",
                      flush=True)
                prev, prev_t = writes, now_t
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()
