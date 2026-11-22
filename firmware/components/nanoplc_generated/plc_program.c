/* Auto-generated from IR v1 — do not edit. */
#include "nanoplc_generated.h"
#include "nanoplc_hal.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

static bool npgen_di[2];
static bool npgen_do[1];
static bool npgen_v___and1_Q;
static bool npgen_v_DI_Enable;
static bool npgen_v_DI_Start;
static bool npgen_v_DO_Lamp;

uint32_t nanoplc_generated_magic(void)
{
    return 0x01e02f01u;
}

static void npgen_task_main_task(uint32_t npgen_dt_ms)
{
    (void)npgen_dt_ms;
    npgen_di[0] = nanoplc_hal_read_di(0);
    npgen_v_DI_Start = npgen_di[0];
    npgen_di[1] = nanoplc_hal_read_di(1);
    npgen_v_DI_Enable = npgen_di[1];
    npgen_v___and1_Q = (npgen_v_DI_Start && npgen_v_DI_Enable);
    npgen_do[0] = npgen_v___and1_Q;
    nanoplc_hal_write_do(0, npgen_v___and1_Q);
    npgen_v_DO_Lamp = npgen_v___and1_Q;
}

static const nanoplc_task_desc_t npgen_tasks[] = {
    { "main_task", NANOPLC_TASK_CYCLIC, 1u, 10u, 50u, NANOPLC_WATCHDOG_HOLD, true, NANOPLC_EVENT_NONE, 0u, NULL,
      npgen_task_main_task },
};

const nanoplc_task_desc_t *nanoplc_generated_tasks(size_t *out_count)
{
    *out_count = sizeof(npgen_tasks) / sizeof(npgen_tasks[0]);
    return npgen_tasks;
}
