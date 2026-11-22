#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/** Start a low-priority task that emits `#NP1` UART telemetry (`docs/DEBUG_PROTOCOL.md`). */
void nanoplc_debug_init(void);

#ifdef __cplusplus
}
#endif
