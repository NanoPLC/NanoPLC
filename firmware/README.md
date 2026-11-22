# NanoPLC firmware (ESP-IDF)

Runtime described in **`docs/VIRTUAL_PLC_PLAN.md` §5.7 and §14**: one FreeRTOS task per PLC task from the generated `nanoplc_generated_tasks()` table, overrun / watchdog logs per task id, and Task WDT membership.

## Task runtime

| PLC task kind | FreeRTOS loop | Δt passed to the task |
|---------------|---------------|-----------------------|
| cyclic | `xTaskDelayUntil(interval_ms)` | `interval_ms`; after a missed deadline, the real elapsed time (missed passes are skipped, not replayed) |
| freewheeling | one pass, then `vTaskDelay(1)` | measured elapsed time since the previous pass |
| event | poll every tick; run on rising edge of DI / BOOL var | Δt = 0 on first edge, then elapsed since previous run |

- PLC priority `p` (0 = highest) → FreeRTOS priority `configMAX_PRIORITIES - 2 - p`, at least 1.
- All PLC tasks are pinned to core 1 (core 0 with `CONFIG_FREERTOS_UNICORE`), so priorities order them deterministically and Wi-Fi stays on core 0.
- `CONFIG_FREERTOS_HZ=1000` (`sdkconfig.defaults`): intervals are exact in milliseconds. An existing `sdkconfig` keeps its old tick rate; delete it (or run `idf.py menuconfig`) after upgrading. The runtime warns at boot when an interval is not a whole number of ticks.
- `nanoplc_hal` serializes DI / DO / AI access with a mutex, because PLC tasks preempt each other and I2C expander drivers do read-modify-write on shared registers.
- Overrun logs are rate-limited to one per second per task and report how many were suppressed.

## Requirements

- [ESP-IDF](https://docs.espressif.com/projects/esp-idf/) (pin a minor line with your team—see plan §40).
- Default SoC: **ESP32-S3** (`idf.py set-target esp32s3`).

## Build

```bash
cd firmware
idf.py set-target esp32s3
idf.py build
```

To build with the logic of a NanoPLC project instead of the committed stub, generate the code first (from the repo root):

```bash
(cd packages/ir-schema && npm install && npm run compile)
(cd tools/codegen && npm install)
node tools/codegen/cli.js --project examples/blink_fbd firmware/components/nanoplc_generated
```

CI (`.github/workflows/firmware-ci.yml`) builds the stub and every example this way with ESP-IDF **v5.3.3** for `esp32s3`.

Flash + monitor:

```bash
idf.py flash monitor
```

## Layout

| Path | Role |
|------|------|
| `main/` | `app_main` bootstraps `nanoplc_runtime_init` |
| `components/nanoplc_runtime/` | One FreeRTOS task per PLC task, watchdog, overrun logs |
| `components/nanoplc_debug/` | Optional UART `#NP1` telemetry (`docs/DEBUG_PROTOCOL.md`) |
| `components/nanoplc_hal/` | GPIO process-image HAL (`nanoplc_hal_read_di` / `write_do`) |
| `components/nanoplc_generated/` | Codegen output (`plc_program.c`, `io_hal_config.c`) |

**`NANOPLC_RUNTIME_ABI_VERSION`** (3: event triggers + watchdog action) lives in `nanoplc_runtime.h`. The task table type `nanoplc_task_desc_t` and **`nanoplc_generated_magic`** live in `nanoplc_generated.h` / `plc_program.c`.
