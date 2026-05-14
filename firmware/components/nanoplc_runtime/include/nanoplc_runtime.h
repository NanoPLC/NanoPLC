#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Must stay aligned with codegen expectations + build manifest (plan §29). */
#define NANOPLC_RUNTIME_ABI_VERSION 1u

/**
 * Starts the PLC scan FreeRTOS task with the requested period in milliseconds.
 * When `period_ms` is zero a 10 ms default applies.
 */
void nanoplc_runtime_init(uint32_t scan_period_ms);

#ifdef __cplusplus
}
#endif
