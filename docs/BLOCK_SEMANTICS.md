# NanoPLC block semantics (IR v1)

This document defines how each FBD block behaves at runtime. The TS simulator (`packages/ir-schema/src/simulator/executeScan.ts`) and the generated C (`packages/ir-schema/src/codegen/cGenerator.ts`) must both follow it. A difference between them is a bug, unless it is listed under [Known gaps](#known-gaps).

The block names follow IEC 61131-3. NanoPLC does **not** claim conformance (see `VIRTUAL_PLC_PLAN.md` §39). Where NanoPLC differs from typical IEC behavior, this document says so.

See also: `docs/IR_SCHEMA.md` (wire format), `VIRTUAL_PLC_PLAN.md` §5 (tasks), §36 (parity checklist).

## 1. Execution model

### 1.1. One pass of a task

Each pass of a task runs the entry PROGRAM's `schedule` from first step to last. A `call` step runs the callee's schedule inline (§6). There are no other implicit phases.

- **Inputs** are read when a `read_di` / `read_ai` step runs. DI and AI blocks have no inputs, so the compiler always places them first. In practice, all inputs are sampled at the start of the pass.
- **Outputs** are written to the hardware when the `write_do` step runs. There is no end-of-pass output flush in v0.

### 1.2. Evaluation order

The compiler sorts blocks topologically along the wires (Kahn's algorithm): a block runs after every block that feeds it. Ties between independent blocks are broken by the order of `blocks[]` and `wires[]` in the FBD file. That order is deterministic for a given file, but it is not a contract, so do not rely on it. The canvas position does not affect the order.

A wire loop without a stateful block in between is a compile error (`NP-0400`). Timers and RS do not break a loop in v0: use a PROGRAM variable (`LOCAL` write, then `LOCAL` read on the next pass) for feedback.

### 1.3. Unconnected inputs

| Input type | Value |
|------------|-------|
| BOOL | `FALSE` |
| Numeric | `0` |

A `DO` with nothing wired to `IN` writes `FALSE` on every pass.

### 1.4. Cold start

| State | Value before the first pass |
|-------|-----------------------------|
| PROGRAM variables (IN, IN_OUT, OUT, VAR) | `initial`, else `FALSE` / `0` |
| TEMP variables | `initial`, else `FALSE` / `0`, reapplied at the start of every call |
| Wire values | `FALSE` / `0` |
| Timers | `ET = 0`, `Q = FALSE`, previous `IN = FALSE` |
| RS | `Q = FALSE` |
| Physical GPIO outputs | Driven to the inactive level by `nanoplc_hal_init()` before the scan task starts |
| Simulator DO image | `FALSE` |

There is no retain memory in v0. Every reset or power cycle is a cold start.

### 1.5. Time base (Δt)

Timers advance by the **Δt of the task pass that executes them**:

- Firmware: `nanoplc_runtime_scan_period_ms()`, the nominal interval of the primary cyclic task. The measured elapsed time is not used yet, so an overrunning pass still counts as one nominal interval.
- Simulator: `project.scan_period_ms` of the IR, also nominal. Wall-clock jitter of the host has no effect on timer values.

Both sides therefore see the same timer values after the same number of passes.

## 2. Data types

| IR type | C type | Range | Simulator storage |
|---------|--------|-------|-------------------|
| `BOOL` | `bool` | `FALSE` / `TRUE` | `boolean` |
| `INT` | `int16_t` | −32768 … 32767 | `number`, wrapped to 16-bit signed |
| `DINT` | `int32_t` | −2³¹ … 2³¹−1 | `number`, wrapped to 32-bit signed |
| `UINT` | `uint16_t` | 0 … 65535 | `number`, wrapped to 16-bit unsigned |
| `WORD` | `uint16_t` | 0 … 65535 | `number`, wrapped to 16-bit unsigned |
| `REAL` | `float` | IEEE 754 single | `number`, rounded with `Math.fround` |

### 2.1. Implicit conversions

A wire may connect a source to a destination of the same type, or of a **higher rank** in `WORD < UINT < INT < DINT < REAL`. Other combinations are `NP-0305`. BOOL never converts to or from a numeric type.

The rank order is not strictly value-preserving: `UINT` / `WORD` values above 32767 do not fit in `INT`. Converting such a value to `INT` wraps it (40000 → −25536).

### 2.2. Integer arithmetic

- Results wrap in two's complement at the result width: `INT` 32767 + 1 = −32768, `DINT` overflow wraps likewise (the C code computes through `uint32_t`, so there is no undefined behavior).
- Division truncates toward zero: −7 / 2 = −3.
- **Division by zero returns 0.** IEC would raise a runtime error; NanoPLC has no runtime error channel in v0.
- The most negative value divided by −1 returns itself (`INT` −32768 / −1 = −32768).

### 2.3. REAL arithmetic

- Every REAL result is rounded to single precision, as on the MCU. The simulator shows `0.1 + 0.2` as `0.3` but stores `0.300000011920929`.
- **Division by zero returns 0.0**, like integer division.
- `SQRT` of a negative number returns NaN.
- `POW` and `SQRT` call `powf` / `sqrtf` on the MCU and double precision rounded to float in the simulator. Results may differ by one unit in the last place.

## 3. Logic blocks

| Block | Inputs | Output | Rule |
|-------|--------|--------|------|
| `AND` | `IN1`, `IN2` (BOOL) | `Q` (BOOL) | `IN1 AND IN2` |
| `OR` | `IN1`, `IN2` (BOOL) | `Q` (BOOL) | `IN1 OR IN2` |
| `NOT` | `IN` (BOOL) | `Q` (BOOL) | `NOT IN` |
| `RS` | `SET`, `RESET1` (BOOL) | `Q` (BOOL) | Reset-dominant latch: `RESET1` → `Q := FALSE`; else `SET` → `Q := TRUE`; else hold |
| `CONST` | — | `Q` (`params.data_type`) | Fixed literal; invalid value or type is `NP-0215` |

## 4. Timers

All timers have input `IN` (BOOL), output `Q` (BOOL), and preset `params.pt_ms` (whole milliseconds ≥ 0, default 1000; otherwise `NP-0220`). The elapsed time `ET` is internal in v0. The simulator exposes it as `<block id>.ET` in the variable snapshot.

`ET` advances by Δt (§1.5) and **saturates at PT**: it never exceeds the preset. A timer already counts in the pass in which its input changes. With Δt = 10 ms and PT = 30 ms, a timer changes `Q` in the third pass, counting the pass with the triggering edge. For example, TON sets `Q` in the third consecutive pass with `IN = TRUE`.

### 4.1. TON — on-delay

```
IN = TRUE : ET := min(ET + Δt, PT);  Q := (ET >= PT)
IN = FALSE: ET := 0;                 Q := FALSE
```

### 4.2. TOF — off-delay

```
IN = TRUE            : ET := 0;  Q := TRUE
IN = FALSE and Q     : ET := min(ET + Δt, PT);  Q := (ET < PT)
IN = FALSE and not Q : no change
```

A TRUE pulse on `IN` while the delay runs restarts it. With `IN = FALSE` at cold start, `Q` stays `FALSE`.

### 4.3. TP — pulse

```
if not Q and rising edge on IN: Q := TRUE; ET := 0
if Q          : ET := min(ET + Δt, PT);  Q := (ET < PT)
elif IN=FALSE : ET := 0
```

- The pulse length is PT regardless of `IN` after the edge.
- Edges during a pulse are ignored (not retriggerable).
- After the pulse, `ET` stays at PT while `IN` is still `TRUE`. It returns to 0 once `IN` is `FALSE`.
- A rising edge in the pass right after a pulse ended starts a new pulse.
- At cold start the previous `IN` is `FALSE`, so `IN = TRUE` in the first pass starts a pulse.

### 4.4. PT = 0

| Timer | Behavior |
|-------|----------|
| TON | `Q` follows `IN` in the same pass |
| TOF | `Q` follows `IN` in the same pass |
| TP | No pulse (`Q` stays `FALSE`) |

## 5. Math and bit blocks

### 5.1. Math

| Block | Inputs | Output type |
|-------|--------|-------------|
| `ADD`, `SUB`, `MUL`, `DIV` | `IN1`, `IN2` | Highest rank of the wired inputs; `REAL` if an input is unconnected |
| `POW` | `IN1` (base), `IN2` (exponent) | `REAL` |
| `SQRT` | `IN` | `REAL` |

Rules from §2.2 and §2.3 apply.

### 5.2. Bit operations

| Block | Inputs | Rule |
|-------|--------|------|
| `SHL` / `SHR` | `IN`, `N` (INT) | Logical shift; `SHR` fills with zeros even for `INT` / `DINT` |
| `ROL` / `ROR` | `IN`, `N` (INT) | Rotate within the width of `IN` |
| `SETBIT` / `RESETBIT` | `IN`, `BIT` (INT) | Set / clear one bit |

- The output type is the type of the `IN` wire. A `BOOL` or `REAL` source, or no wire, means `WORD`.
- The width is 32 bits for `DINT` and 16 bits otherwise.
- `N` and `BIT` are taken modulo the width (`N AND 15`, or `N AND 31` for DINT). `SHL` of a WORD by 16 therefore equals a shift by 0.
- For `INT`, the 16-bit result is reinterpreted as signed: `ROR` of `INT` 1 by 1 = −32768.

## 6. Programs and variables

- **`LOCAL` read** outputs the current value of the PROGRAM variable.
- **`LOCAL` write** stores its input into the variable when its step runs. Later steps in the same pass see the new value.
- **`CALL`**: before the callee runs, each **wired** IN / IN_OUT port is copied into the callee variable. An unwired input keeps the callee's previous value (or its `initial` on the first call). After the callee returns, every OUT / IN_OUT is copied to the CALL block's output port.
- A callee PROGRAM is a singleton. Several CALL blocks for the same program share its VAR, timer, and RS state.
- VAR keeps its value between passes and between calls. TEMP is reset to `initial` at the start of every call.

## 7. Process image

| Block | Op | Rule |
|-------|----|------|
| `DI` | `read_di` | BOOL from the bound channel (active level from `io-map`) |
| `AI` | `read_ai` | REAL from the bound channel (driver-specific scaling, e.g. volts on StamPLC IO) |
| `DO` | `write_do` | Writes BOOL to the bound channel; the DO symbol also holds the written value |

Each DI / AI / DO symbol may be used by one block per program (`NP-0213`). Tasks share one process image, without locking between tasks (`VIRTUAL_PLC_PLAN.md` §5.5).

## Known gaps

These differences between the simulator and the MCU are known and tracked:

| Gap | Simulator | MCU |
|-----|-----------|-----|
| `LOCAL` write / CALL copy from `UINT` / `WORD` into an `INT` variable | Copies the raw value (40000) | Wraps (−25536) |
| Overrunning pass | Nominal Δt (no overrun possible) | Nominal Δt, with a `scan overrun` log |

## Change log

| IR version | Change |
|------------|--------|
| 1 | Initial semantics. TOF and TP added; TON `ET` saturates at PT in the simulator (C already did); integer wrap and float32 REAL in the simulator. |
