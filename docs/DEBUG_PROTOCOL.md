# NanoPLC online debug protocol (v1)

DEVICE → IDE telemetry over UART/USB CDC (same console as `idf.py monitor`). Force/unforce and Wi‑Fi transports are out of scope for v1 (`VIRTUAL_PLC_PLAN.md` §17 Phase 1).

## Framing

Telemetry shares the log UART, so frames are **printable lines**:

```
#NP1 <hex>\n
```

- `#NP1` — magic + protocol version (`1`)
- `<hex>` — lowercase hex of the binary payload (even length)
- Lines that do not start with `#NP1 ` are ignored by the IDE decoder

## Binary payload

All multi-byte integers are **little-endian**.

| Offset | Size | Field |
|--------|------|-------|
| 0 | 4 | `ir_magic` (`nanoplc_generated_magic()`) |
| 4 | 4 | `seq` — monotonically increasing snapshot counter |
| 8 | 4 | `scan_index` — primary cyclic task passes (best-effort) |
| 12 | 1 | `di_count` |
| 13 | 1 | `do_count` |
| 14 | 1 | `ai_count` |
| 15 | 1 | `var_count` |
| 16 | … | DI bits: `ceil(di_count/8)` bytes, bit `i` = DI `i` |
| … | … | DO bits: same packing |
| … | … | AI values: `ai_count` × `float32` |
| … | … | Variables: `var_count` records (see below) |
| end | 2 | `checksum` — XOR of all preceding payload bytes, stored as `u16` (low byte = XOR, high = 0) |

### Variable record

| Size | Field |
|------|-------|
| 1 | `name_len` (1…32) |
| N | UTF-8 name (no NUL) |
| 1 | `type` — `0` BOOL, `1` INT, `2` UINT, `3` WORD, `4` DINT, `5` REAL |
| 1/2/4 | value — BOOL `u8`, INT/UINT/WORD `i16`/`u16`, DINT `i32`, REAL `float32` |

## Rate

Firmware emits at most one snapshot every **100 ms** when `CONFIG_NANOPLC_DEBUG_TELEMETRY` is enabled (default on in `sdkconfig.defaults` for development). Disable for production builds.

## Handshake

v1 has no handshake. The IDE starts decoding as soon as `#NP1` lines appear. A change of `ir_magic` means the firmware was rebuilt — clear the watch cache.

## Security

UART debug is local. Networked debug remains off by default (plan §27).
