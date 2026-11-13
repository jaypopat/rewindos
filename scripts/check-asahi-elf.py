#!/usr/bin/env python3
"""Reject non-AArch64 or <16 KiB-compatible ELF load segments (stdlib only)."""
import struct
import sys
from pathlib import Path


def check(path):
    data = Path(path).read_bytes()
    if data[:6] != b"\x7fELF\x02\x01":
        raise ValueError(f"{path}: expected ELF64 little-endian")
    if struct.unpack_from("<H", data, 18)[0] != 183:
        raise ValueError(f"{path}: expected AArch64")
    phoff = struct.unpack_from("<Q", data, 32)[0]
    phsize, phnum = struct.unpack_from("<HH", data, 54)
    count = 0
    for i in range(phnum):
        kind, _, offset, vaddr, _, _, _, align = struct.unpack_from(
            "<IIQQQQQQ", data, phoff + i * phsize
        )
        if kind != 1:  # PT_LOAD
            continue
        count += 1
        if align < 16384 or (vaddr - offset) % 16384:
            raise ValueError(f"{path}: PT_LOAD incompatible with 16 KiB pages")
    if not count:
        raise ValueError(f"{path}: no load segments")
    print(f"{path}: AArch64, {count} PT_LOAD segments support 16 KiB pages")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: check-asahi-elf.py ELF...")
    for name in sys.argv[1:]:
        check(name)
