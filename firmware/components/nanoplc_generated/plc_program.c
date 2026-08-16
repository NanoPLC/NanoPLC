/* Auto-generated from IR v1 — do not edit. */
#include "nanoplc_generated.h"
#include "nanoplc_hal.h"

#include <stdbool.h>
#include <stdint.h>

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
    npgen_di[0] = nanoplc_hal_read_di(0);
    npgen_v_DI_Start = npgen_di[0];
    npgen_di[1] = nanoplc_hal_read_di(1);
    npgen_v_DI_Enable = npgen_di[1];
    npgen_v___and1_Q = (npgen_v_DI_Start && npgen_v_DI_Enable);
    npgen_do[0] = npgen_v___and1_Q;
    nanoplc_hal_write_do(0, npgen_v___and1_Q);
    npgen_v_DO_Lamp = npgen_v___and1_Q;
}
