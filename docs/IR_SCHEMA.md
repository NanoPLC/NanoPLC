# NanoPLC IR wire format

NanoPLC uses **JSON** as the canonical intermediate representation (IR) on disk (`build/ir.json`). Binary encodings may be added later for transport; the schema and semantics are defined here first.

See also: `docs/VIRTUAL_PLC_PLAN.md` §15, §20, §29.

## Version fields

| Field | Current value | File |
|-------|---------------|------|
| `schema_version` | `1` | `nanoplc.project.json`, FBD source, `io-map.json` |
| `ir_version` | `1` | `build/ir.json` |

Bump and migrate when semantics change (`packages/ir-schema`).

## Project marker (`nanoplc.project.json`)

```json
{
  "schema_version": 1,
  "name": "and_gate",
  "device": { "board": "esp32-s3", "idf_target": "esp32s3" },
  "scan": { "period_ms": 10 },
  "modules": [
    {
      "id": "gpio1",
      "name": "Onboard GPIO (digital)",
      "type": "gpio_digital_io",
      "config": "src/io-map.json"
    }
  ],
  "drivers": [
    {
      "id": "hal_gpio",
      "name": "GPIO process image (nanoplc_hal)",
      "type": "nanoplc_hal",
      "binds": "gpio1"
    }
  ],
  "programs": [
    { "id": "main", "name": "Main", "source": "src/main.fbd.json", "language": "fbd" }
  ],
  "firmware_root": "firmware"
}
```

Optional **`modules[]`** and **`drivers[]`** drive the TIA-style Project tree (§3.2). When omitted, the IDE assumes one onboard GPIO module and `nanoplc_hal`.

**Device catalog fields** on `device`:

| Field | Example | Role |
|-------|---------|------|
| `catalog_id` | `m5stack.stamplc_k141` | Template used at **Add device** |
| `vendor` | `M5Stack` | Shown in Project tree |
| `model` | `StamPLC (K141)` | Shown in Project tree |
| `board` | `m5stack-stamplc` | Compile / codegen metadata |
| `idf_target` | `esp32s3` | ESP-IDF `set-target` |

## FBD source (`src/*.fbd.json`)

Graph stored as **blocks + wires**. Block `id` values are stable handles for diagnostics (`NP-xxxx`).

Optional **`layout`** map (`block id → { x, y }`) stores canvas positions for the FBD editor; the IR compiler ignores it.

Open `*.fbd.json` in VS Code with the **FBD Diagram** custom editor (palette, pan/zoom, wiring, properties).

Supported block types (v0): `DI`, `DO`, `AND`, `OR`, `NOT`, `TON`, `CONST`.

For `DI` / `DO`, set `params.channel` (1-based hardware channel from the device catalog / `io-map`) and `params.symbol` (usually `DI_n` / `DO_n`). The FBD editor lists free channels from the project device profile and prevents selecting the same channel twice. Compile diagnostics: `NP-0212` (duplicate channel), `NP-0213` (duplicate symbol), `NP-0214` (missing channel assignment).

`CONST` is a typed literal (`params.data_type` + `params.value`) with output `Q`. Supported types: `BOOL`, `INT`, `DINT`, `UINT`, `WORD`, `REAL`. The type and value are shown on the block. Wiring a non-BOOL constant into a BOOL input (logic / DO / TON) produces `NP-0305`. Invalid values produce `NP-0215`.

Device I/O counts live in `DeviceIoProfile` (`di_count` / `do_count`); optional `di_channels` / `do_channels` arrays override the default `1..N` numbering for modular devices.

## Compiled IR (`build/ir.json`)

Top-level entities:

| Entity | Role |
|--------|------|
| `project` | Name, board, scan period, active program |
| `variables` | Symbols with PLC types and roles (`di`, `do`, `internal`, …) |
| `io_image` | Ordered DI/DO index map for simulator and HAL |
| `network` | Original FBD blocks and wires |
| `instances` | FB instances (e.g. `TON`) |
| `schedule` | **Ordered** execution steps (topological compile output) |

Example schedule fragment:

```json
{ "step": 2, "op": "and", "in1": "DI_Start", "in2": "DI_Enable", "out": "__and1_Q" }
```

## Compile diagnostics

Stable codes live in `packages/ir-schema` (e.g. `NP-0400` combinational cycle). The VS Code extension surfaces them in **Problems** when you run **NanoPLC: Compile PLC program**.

## Implementation

Types, validation, and `compileFbdToIr()` live in **`packages/ir-schema/`**. The VS Code extension depends on this package via `file:../packages/ir-schema`.

### Simulator

`PlcSimulator` loads compiled `PlcIr` and runs the ordered `schedule` each scan. Supported ops: `read_di`, `write_do`, `and`, `or`, `not`, `ton`, `move`, `const`.

### C codegen

`codegenC(ir, irSha256)` emits `plc_program.c` for `nanoplc_generated`. CLI: `tools/codegen/` (`nanoplc-codegen`).

With `src/io-map.json`, codegen also emits **`io_hal_config.c`** (GPIO tables) and scan logic calls `nanoplc_hal_read_di` / `nanoplc_hal_write_do`.


JSON Schema files (optional editor validation): `packages/ir-schema/schemas/`.
