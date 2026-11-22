# Shared C execution core — migration plan

Goal: move from **Phase A** (TS `PlcSimulator` + C codegen for MCU) to **Phase B** (one C execution core for host SoftPLC and ESP32) without rewriting the FBD editor (`VIRTUAL_PLC_PLAN.md` §4.2, §11 Phase 2).

This document is the migration plan. Implementation is **not** started.

## What stays in TypeScript

| Piece | Why |
|-------|-----|
| FBD / project editors, Device tree, watch UI | VS Code / webview surface |
| FBD → IR compiler (`packages/ir-schema`) | Authoring + diagnostics (`NP-xxxx`) |
| IR JSON on disk, golden scenario definitions | Portable fixtures |
| Codegen that emits process-image tables / HAL bind | Board-specific glue |

## What moves into shared C

| Piece | Today | Target |
|-------|--------|--------|
| Schedule interpreter (ops, timers, RS, CALL) | TS `executeScan.ts` + generated straight-line C | One interpreter or bytecode VM over IR `schedule` |
| Task virtual-time / FreeRTOS scheduling | Split: TS scheduler vs `nanoplc_runtime` | Shared “pass runner”; hosts differ only in time source |
| Typed numeric wrap / BOOL image | Duplicated TS + C | Single implementation under UBSan + host golden |

## ABI and versions

- Keep **`ir_version`** as the semantic contract of IR JSON.
- Keep **`NANOPLC_RUNTIME_ABI_VERSION`** for the FreeRTOS ↔ generated table layout (currently v3).
- Add a third version if a bytecode/`nanoplc_core` API appears; bump only when the host SoftPLC and MCU disagree.

## Host vs Xtensa

| Build | Role |
|-------|------|
| Host (x86/ARM desktop) | SoftPLC + golden harness (already compiles generated `plc_program.c` with stub HAL) |
| Xtensa (ESP-IDF) | Production firmware; same core sources via `idf_component_register` |

Prefer a small `nanoplc_core` component with no ESP-IDF deps so host CMake and IDF both consume it.

## How host-C golden prefigures Phase B

`packages/ir-schema` golden tests already:

1. Compile project → IR → `codegenC` → `plc_program.c`
2. Link with stub HAL + a virtual-time scheduler mirroring `PlcSimulator`
3. Assert the same traces as the TS simulator (with UBSan when available)

Phase B replaces the generated straight-line schedule bodies with calls into `nanoplc_core`, while keeping the same golden scenarios as the exit gate.

## Exit criteria to start the rewrite

1. Phase 2 UART online debug stable enough for field bring-up.
2. Known gaps in `BLOCK_SEMANTICS.md` limited to intentional platform caveats.
3. Agreement on bytecode vs AST interpreter (recommend: start with **AST/schedule interpreter** over IR JSON loaded at runtime on host; MCU may keep codegen until RAM pressure forces bytecode).
4. CI job that builds `nanoplc_core` for host **and** links it into the ESP-IDF firmware stub.

## Non-goals for the first shared-core milestone

- IEC certification, retain memory, multi-core process-image locking.
- Replacing the FBD canvas or ST grammar.
- Dropping TS simulation before host SoftPLC parity is proven.
