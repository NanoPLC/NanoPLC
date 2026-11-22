/**
 * Interface for user-generated PLC logic.
 * Header contract for the IR-to-C code generator (docs/VIRTUAL_PLC_PLAN.md §16).
 */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Placeholder magic until real IR-driven codegen ships. */
#define NANOPLC_GENERATED_MAGIC_STUB 0u

typedef enum {
    NANOPLC_TASK_CYCLIC = 0,
    NANOPLC_TASK_FREEWHEELING = 1,
    NANOPLC_TASK_EVENT = 2,
} nanoplc_task_kind_t;

/** One PLC task of the Task Configuration (IR `tasks[]`). */
typedef struct {
    const char *id;
    nanoplc_task_kind_t kind;
    /** 0 = highest ... 31 = lowest (CODESYS-like). */
    uint8_t priority;
    /** Cyclic period; 0 for other kinds. */
    uint32_t interval_ms;
    /** Pass time budget for overrun logs; 0 = none. */
    uint32_t watchdog_ms;
    /** Primary cyclic task (drives `scan_period_ms`). */
    bool primary;
    /** Runs one pass: inputs, entry PROGRAM, outputs. `dt_ms` advances timers. */
    void (*run)(uint32_t dt_ms);
} nanoplc_task_desc_t;

/** Static task table; `*out_count` may be 0 (stub firmware). */
const nanoplc_task_desc_t *nanoplc_generated_tasks(size_t *out_count);

/** Binds generated GPIO tables to nanoplc_hal (call before PLC tasks start). */
void nanoplc_generated_io_bind(void);

uint32_t nanoplc_generated_magic(void);

#ifdef __cplusplus
}
#endif
