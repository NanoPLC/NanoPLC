# NanoPLC IR wire format

NanoPLC uses **JSON** as the canonical intermediate representation (IR) on disk (`build/ir.json`). Binary encodings may be added later for transport; the schema and semantics are defined here first.

See also: `docs/VIRTUAL_PLC_PLAN.md` §5 (tasks), §15, §20, §29; `docs/BLOCK_SEMANTICS.md` (runtime behavior of each block).

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
  "tasks": [
    {
      "id": "main_task",
      "name": "MainTask",
      "kind": "cyclic",
      "priority": 1,
      "interval_ms": 10,
      "watchdog": { "enabled": true, "time_ms": 50 },
      "program": "main"
    }
  ],
  "programs": [
    { "id": "main", "name": "Main", "source": "src/main.fbd.json", "language": "fbd" }
  ],
  "firmware_root": "firmware"
}
```

Optional **`modules[]`** and **`drivers[]`** drive the Project tree (§3.2). When omitted, the IDE assumes one onboard GPIO module and `nanoplc_hal`.

**`tasks[]`** is the CODESYS-style **Task Configuration** (`docs/VIRTUAL_PLC_PLAN.md` §5). Each task has `kind` (`cyclic` | `freewheeling` | `event`), `priority` (0 = highest … 31 = lowest), optional `interval_ms` / `event` / `watchdog`, and **`program`** — the single entry PROGRAM. Extra programs belong on other tasks, or are invoked with an FBD **`CALL`** block (`params.program`).

When `tasks[]` is omitted, the IDE synthesizes **MainTask** from `scan.period_ms` and the first program. `scan.period_ms` remains a cache of the **primary cyclic** interval for IR `scan_period_ms` (compile T0). Compile emits every task into IR `tasks`; the Virtual PLC runs all of them, firmware still runs only the primary task (until T1b). Legacy `pous[]` with one entry is still accepted.

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

Supported block types (v0): `DI`, `DO`, `AI`, `AND`, `OR`, `NOT`, `RS`, `TON`, `TOF`, `TP`, `CONST`, `ADD`, `SUB`, `MUL`, `DIV`, `POW`, `SQRT`, `SETBIT`, `RESETBIT`, `SHL`, `SHR`, `ROL`, `ROR`, `CALL`, `LOCAL`.

**`CALL`** invokes another FBD PROGRAM (`params.program` = callee id). The box shows the callee’s **IN**, **IN_OUT**, and **OUT** variables as ports. VAR and TEMP stay internal. The callee is a singleton that shares the process image (DI/DO/AI symbols) and keeps VAR state between calls. TEMP is reset at the start of every call. The current program is omitted from the FBD **Programs** palette. Self-call is `NP-0410`; a call cycle is `NP-0411`; empty `params.program` is `NP-0412`; unknown id is `NP-0413`. ST programs cannot be called (`NP-0205`).

Each FBD program may declare **`variables[]`**: `{ name, class, type, initial? }` with `class` one of `IN`, `IN_OUT`, `OUT`, `VAR`, `TEMP`. Use them on the canvas with **`LOCAL`** blocks (`params.name`). Invalid names are `NP-0216`; duplicates `NP-0217`; unknown LOCAL target `NP-0219`.

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

**Timers** `TON` (on-delay), `TOF` (off-delay), and `TP` (pulse) have one BOOL input `IN`, output `Q`, and `params.pt_ms` (preset time in whole milliseconds, default `1000`). Schedule ops are `ton` / `tof` / `tp` with `pt_ms` and `block_id`. ET advances by the executing task's Δt and saturates at PT. A negative, fractional, or non-numeric PT is `NP-0220`. Exact edge cases (PT = 0, retrigger, cold start) are in `docs/BLOCK_SEMANTICS.md`.

## Compiled IR (`build/ir.json`)

Top-level entities:

| Entity | Role |
|--------|------|
| `project` | Name, board, scan period (primary cyclic task), active program |
| `variables` | Symbols with PLC types and roles (`di`, `do`, `ai`, `internal`, …) |
| `io_image` | Ordered DI / DO / AI index map for simulator and HAL |
| `network` | Original FBD blocks and wires |
| `instances` | FB instances (e.g. `TON`, `TOF`, `TP`, `RS`) |
| `schedule` | **Ordered** execution steps of the primary cyclic task's entry PROGRAM (topological compile output) |
| `pou_schedules` | Callee PROGRAM schedules invoked by `call` ops (omitted when there are no CALLs) |
| `tasks` | Every task of the Task Configuration: `id`, `name`, `kind`, `priority`, `interval_ms` / `event`, `watchdog_ms`, `program`, `primary`, and the entry PROGRAM's `schedule` |

`tasks` is written by `compileTasksToIr()` (IDE compile). Older IR without `tasks` runs `schedule` as a single cyclic task. Names are prefixed per program (`<prog>__<var>`, `__<prog>_...`) whenever more than one program is compiled, so tasks never collide.

**Virtual PLC scheduling** (deterministic virtual time): a cyclic task passes at every multiple of `interval_ms` with Δt = `interval_ms`; a freewheeling task passes every 1 ms with Δt = 1. Passes due at the same instant run in priority order (0 first). Event tasks are compiled but not scheduled yet. `scan_index` counts passes of the primary task; `task_passes` counts passes per task id.

Example schedule fragments:

```json
{ "step": 2, "op": "and", "in1": "DI_Start", "in2": "DI_Enable", "out": "__and1_Q" }
{ "step": 3, "op": "call", "program": "aux", "block_id": "call1" }
```

## Compile diagnostics

Stable codes live in `packages/ir-schema` (e.g. `NP-0400` combinational cycle). The VS Code extension surfaces them in **Problems** when you run **NanoPLC: Compile PLC program**.

Task configuration: `NP-0106` invalid task, `NP-0107` duplicate task id, `NP-0108` unknown program in a task, `NP-0109` cyclic task missing `interval_ms`, `NP-0110` priority out of 0..31, `NP-0112` event task without variable (warning), `NP-0113` no entry program (warning), `NP-0115` same PROGRAM bound to multiple tasks (warning), `NP-0116` more than one program on a task, `NP-0117` a PROGRAM is reachable from several tasks, so its state is shared without locking (warning), `NP-0118` event task compiled but not scheduled yet (warning).

Program `CALL`: `NP-0410` self-call, `NP-0411` call cycle, `NP-0412` CALL with no program, `NP-0413` unknown program.

Program variables: `NP-0216` invalid name, `NP-0217` duplicate name, `NP-0218` invalid class/type, `NP-0219` LOCAL block with unknown variable.

Timers: `NP-0220` invalid `pt_ms` on `TON` / `TOF` / `TP`.

## Implementation

Types, validation, `compileFbdToIr()`, `compileProjectToIr()` (one entry PROGRAM plus transitive `CALL`s), and `compileTasksToIr()` (every task's entry PROGRAM plus their `CALL`s) live in **`packages/ir-schema/`**. The VS Code extension depends on this package via `file:../packages/ir-schema`.

### Simulator

`PlcSimulator` loads compiled `PlcIr` and runs the ordered `schedule` each scan. A `call` step runs the matching `pou_schedules` entry (shared vars / process image; recursion is skipped at runtime and rejected at compile). Supported ops include `read_di`, `read_ai`, `write_do`, `and`, `or`, `not`, `ton`, `tof`, `tp`, `move`, `const`, `call`, math, and bit ops. The simulation webview is a watch list: add **DI / DO / AI** by module and channel, and add PROGRAM **IN / IN_OUT / OUT / VAR / TEMP** symbols.

### C codegen

`codegenC(ir, irSha256)` emits `plc_program.c` for `nanoplc_generated`. Each callee becomes `static void npgen_pou_<id>(void);` invoked from the scan (or from another pou). CLI: `tools/codegen/` (`nanoplc-codegen`).

With project I/O metadata (`src/io-map.json`, `src/modules/*.json`), codegen emits **`io_hal_config.c`**: GPIO tables plus registered DI/DO/AI hooks (`nanoplc_hal_read_di`, `nanoplc_hal_write_do`, `nanoplc_hal_read_ai`) for onboard AW9523 and StamPLC IO I2C drivers when present in the device tree.


JSON Schema files (optional editor validation): `packages/ir-schema/schemas/`.
