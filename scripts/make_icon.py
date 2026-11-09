#!/usr/bin/env python3
"""Create original Nikola's Kitchen launcher and web icons using only Python stdlib."""
from pathlib import Path
import struct
import zlib

FOREST = (25, 63, 54)
SAGE = (45, 105, 83)
CREAM = (247, 250, 243)
BERRY = (203, 112, 137)

def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

def write_icon(dest, size):
    rows = []
    for yy in range(size):
        y = (yy + .5) / size
        row = bytearray([0])
        for xx in range(size):
            x = (xx + .5) / size
            c = FOREST
            if (x - .50) ** 2 + (y - .50) ** 2 < .42 ** 2:
                c = SAGE
            if .27 < y < .73:
                diagonal = .34 + (y - .27) * (.31 / .46)
                if (.307 < x < .390 or .610 < x < .693 or abs(x - diagonal) < .040):
                    c = CREAM
            if (x - .75) ** 2 + (y - .27) ** 2 < .036 ** 2:
                c = BERRY
            row.extend(c + (255,))
        rows.append(bytes(row))
    raw = b"".join(rows)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    Path(dest).parent.mkdir(parents=True, exist_ok=True)
    Path(dest).write_bytes(png)

write_icon("assets/icon.png", 1024)
write_icon("www/icon-192.png", 192)
write_icon("www/icon-512.png", 512)
