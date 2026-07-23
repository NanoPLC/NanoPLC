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

Supported block types (v0): `DI`, `DO`, `AI`, `AND`, `OR`, `NOT`, `RS`, `TON`, `CONST`, `ADD`, `SUB`, `MUL`, `DIV`, `POW`, `SQRT`, `SETBIT`, `RESETBIT`, `SHL`, `SHR`, `ROL`, `ROR`.

For `DI`, `DO`, and `AI`, bind the block to a process-image row via the FBD editor **module → channel** picker. Persisted params:

| Param | Role |
|-------|------|
| `params.moduleId` | Hardware module id from `nanoplc.project.json` → `modules[]` (e.g. `stamplc_io`, `stamplc_io_exp1`) |
| `params.channel` | **Local** 1-based channel within that module (not the global process-image index) |
| `params.symbol` | Canonical row name in merged `io-map` (e.g. `DO_1`, `DO_5`, `AI_1`) — used by the compiler and HAL |

The editor lists channels **per module** (onboard vs expansion). The same local channel number may exist on different modules; the editor prevents reusing the same **symbol**. Compile diagnostics: `NP-0213` (duplicate symbol), `NP-0214` (missing module/channel or symbol). (`NP-0212` duplicate channel is **retired** — multi-module projects use symbol uniqueness instead.)

Expansion modules use `src/modules/<id>.json` (merged with onboard `src/io-map.json`). See `packages/ir-schema/src/moduleCatalog.ts`.

Device I/O counts live in `DeviceIoProfile` / module catalog (`di_count` / `do_count` / `ai_count`); optional `di_channels` / `do_channels` / `ai_channels` arrays override default `1..N` numbering inside a module template.

`CONST` is a typed literal (`params.data_type` + `params.value`) with output `Q`. Supported types: `BOOL`, `INT`, `DINT`, `UINT`, `WORD`, `REAL`. The type and value are shown on the block. Wiring a non-BOOL constant into a BOOL input (logic / DO / TON / RS) produces `NP-0305`. Invalid values produce `NP-0215`.

**Math blocks** (`ADD`, `SUB`, `MUL`, `DIV`, `POW`, `SQRT`) infer their output type from wired inputs: `REAL > DINT > INT > UINT/WORD`. `POW` and `SQRT` always produce `REAL`. Unconnected numeric inputs default to `REAL`.

**Bit blocks** (`SETBIT`, `RESETBIT`, `SHL`, `SHR`, `ROL`, `ROR`) inherit the integer width from the `IN` wire (`WORD`, `UINT`, `DINT`, `INT`). Port `BIT` / `N` expects `INT`.

**RS** is a reset-dominant set/reset latch (IEC 61131): ports `SET`, `RESET1`, output `Q`. When both inputs are active, `Q` is `FALSE`. Cold start: `Q = false`.

## Compiled IR (`build/ir.json`)

Top-level entities:

| Entity | Role |
|--------|------|
| `project` | Name, board, scan period, active program |
| `variables` | Symbols with PLC types and roles (`di`, `do`, `ai`, `internal`, …) |
| `io_image` | Ordered DI / DO / AI index map for simulator and HAL |
| `network` | Original FBD blocks and wires |
| `instances` | FB instances (e.g. `TON`, `RS`) |
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

`PlcSimulator` loads compiled `PlcIr` and runs the ordered `schedule` each scan. Supported ops: `read_di`, `read_ai`, `write_do`, `and`, `or`, `not`, `ton`, `move`, `const`. The simulation webview exposes manual **DI**, **DO**, and **AI** (REAL) values for bound channels.

### C codegen

`codegenC(ir, irSha256)` emits `plc_program.c` for `nanoplc_generated`. CLI: `tools/codegen/` (`nanoplc-codegen`).

With project I/O metadata (`src/io-map.json`, `src/modules/*.json`), codegen emits **`io_hal_config.c`**: GPIO tables plus registered DI/DO/AI hooks (`nanoplc_hal_read_di`, `nanoplc_hal_write_do`, `nanoplc_hal_read_ai`) for onboard AW9523 and StamPLC IO I2C drivers when present in the device tree.


JSON Schema files (optional editor validation): `packages/ir-schema/schemas/`.
