# NanoPLC firmware (ESP-IDF)

Skeleton described in **`docs/VIRTUAL_PLC_PLAN.md` §14**: PLC scan loop in a dedicated FreeRTOS task, stub `nanoplc_generated_program_scan`, scan timing telemetry, and Task WDT membership.

## Requirements

- [ESP-IDF](https://docs.espressif.com/projects/esp-idf/) (pin a minor line with your team—see plan §40).
- Default SoC: **ESP32-S3** (`idf.py set-target esp32s3`).

## Build

```bash
cd firmware
idf.py set-target esp32s3
idf.py build
```

Flash + monitor:

```bash
idf.py flash monitor
```

## Layout

| Path | Role |
|------|------|
| `main/` | `app_main` bootstraps `nanoplc_runtime_init` |
| `components/nanoplc_runtime/` | Scan cadence, watchdog, scan duration metrics |
| `components/nanoplc_hal/` | GPIO process-image HAL (`nanoplc_hal_read_di` / `write_do`) |
| `components/nanoplc_generated/` | Codegen output (`plc_program.c`, `io_hal_config.c`) |

**`NANOPLC_RUNTIME_ABI_VERSION`** lives in `nanoplc_runtime.h`. **`nanoplc_generated_magic`** lives in `nanoplc_generated.h` / `plc_program.c`.
