/**
 * Interface for user-generated PLC logic.
 * Header contract for the IR-to-C code generator (docs/VIRTUAL_PLC_PLAN.md §16).
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Placeholder magic until real IR-driven codegen ships. */
#define NANOPLC_GENERATED_MAGIC_STUB 0u

void nanoplc_generated_program_scan(void);

/** Binds generated GPIO tables to nanoplc_hal (call before scan task starts). */
void nanoplc_generated_io_bind(void);

uint32_t nanoplc_generated_magic(void);

#ifdef __cplusplus
}
#endif
