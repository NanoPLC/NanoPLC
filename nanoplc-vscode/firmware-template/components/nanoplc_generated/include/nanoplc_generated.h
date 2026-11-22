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

typedef enum {
    NANOPLC_EVENT_NONE = 0,
    /** Rising edge of a digital input (process-image index). */
    NANOPLC_EVENT_DI = 1,
    /** Rising edge of a BOOL IR variable (address of generated static). */
    NANOPLC_EVENT_VAR = 2,
} nanoplc_event_kind_t;

typedef enum {
    /** Log overrun only; outputs keep their last values. */
    NANOPLC_WATCHDOG_HOLD = 0,
    /** Force every DO OFF and latch until reboot. */
    NANOPLC_WATCHDOG_OUTPUTS_OFF = 1,
} nanoplc_watchdog_action_t;

/** One PLC task of the Task Configuration (IR `tasks[]`). ABI v3. */
typedef struct {
    const char *id;
    nanoplc_task_kind_t kind;
    /** 0 = highest ... 31 = lowest (CODESYS-like). */
    uint8_t priority;
    /** Cyclic period; 0 for other kinds. */
    uint32_t interval_ms;
    /** Pass time budget for overrun logs / fail-safe; 0 = none. */
    uint32_t watchdog_ms;
    nanoplc_watchdog_action_t watchdog_action;
    /** Primary cyclic task (drives `scan_period_ms`). */
    bool primary;
    /** Event trigger kind (`EVENT` tasks); `NONE` otherwise. */
    nanoplc_event_kind_t event_kind;
    /** Process-image DI index when `event_kind == DI`. */
    uint16_t event_di_index;
    /** Address of a BOOL generated variable when `event_kind == VAR`. */
    const bool *event_var;
    /** Runs one pass: inputs, entry PROGRAM, outputs. `dt_ms` advances timers. */
    void (*run)(uint32_t dt_ms);
} nanoplc_task_desc_t;

/** Static task table; `*out_count` may be 0 (stub firmware). */
const nanoplc_task_desc_t *nanoplc_generated_tasks(size_t *out_count);

/** Binds generated GPIO tables to nanoplc_hal (call before PLC tasks start). */
void nanoplc_generated_io_bind(void);

uint32_t nanoplc_generated_magic(void);

/** PLC types for online debug var meta (`docs/DEBUG_PROTOCOL.md`). */
typedef enum {
    NANOPLC_VT_BOOL = 0,
    NANOPLC_VT_INT = 1,
    NANOPLC_VT_UINT = 2,
    NANOPLC_VT_WORD = 3,
    NANOPLC_VT_DINT = 4,
    NANOPLC_VT_REAL = 5,
} nanoplc_var_type_t;

typedef struct {
    const char *name;
    nanoplc_var_type_t type;
    /** Address of the generated static (`npgen_v_*`). */
    const void *addr;
} nanoplc_var_meta_t;

const nanoplc_var_meta_t *nanoplc_generated_var_meta(size_t *out_count);

size_t nanoplc_generated_di_count(void);
size_t nanoplc_generated_do_count(void);
size_t nanoplc_generated_ai_count(void);
bool nanoplc_generated_peek_di(size_t index);
bool nanoplc_generated_peek_do(size_t index);
float nanoplc_generated_peek_ai(size_t index);

#ifdef __cplusplus
}
#endif
