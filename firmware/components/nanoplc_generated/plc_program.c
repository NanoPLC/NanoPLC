/* Auto-generated from IR v1 — do not edit. */
#include "nanoplc_generated.h"
#include "nanoplc_hal.h"

#include <stdbool.h>
#include <stdint.h>

/* Provided by nanoplc_runtime — forward declare to avoid CMake cycle (generated ↔ runtime). */
uint32_t nanoplc_runtime_scan_period_ms(void);

#define NPGEN_SCAN_DT_MS 10u

static bool npgen_di[2];
static bool npgen_do[1];
static bool npgen_v_DI_Enable;
static bool npgen_v_DI_Start;
static bool npgen_v_DO_Lamp;
static bool npgen_v___and1_Q;

uint32_t nanoplc_generated_magic(void)
{
    return 0x01e81e01u;
}

void nanoplc_generated_program_scan(void)
{
    const uint32_t npgen_scan_dt_ms = nanoplc_runtime_scan_period_ms();

    npgen_di[0] = nanoplc_hal_read_di(0);
    npgen_v_DI_Start = npgen_di[0];
    npgen_di[1] = nanoplc_hal_read_di(1);
    npgen_v_DI_Enable = npgen_di[1];
    npgen_v___and1_Q = (npgen_v_DI_Start && npgen_v_DI_Enable);
    npgen_do[0] = npgen_v___and1_Q;
    nanoplc_hal_write_do(0, npgen_v___and1_Q);
    npgen_v_DO_Lamp = npgen_v___and1_Q;
}
