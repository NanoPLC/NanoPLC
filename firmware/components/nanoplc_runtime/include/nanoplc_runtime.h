#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Must stay aligned with codegen expectations + build manifest (plan §29).
 * v2: per-task entry points via `nanoplc_generated_tasks()` (T1).
 */
#define NANOPLC_RUNTIME_ABI_VERSION 2u

/**
 * Binds I/O and starts one FreeRTOS task per PLC task from the generated task table.
 * PLC priority p maps to FreeRTOS priority `configMAX_PRIORITIES - 2 - p` (at least 1).
 * All PLC tasks run on one core so priorities order them deterministically.
 */
void nanoplc_runtime_init(void);

/** Interval of the primary cyclic task in milliseconds (0 when there is none). */
uint32_t nanoplc_runtime_scan_period_ms(void);

#ifdef __cplusplus
}
#endif
