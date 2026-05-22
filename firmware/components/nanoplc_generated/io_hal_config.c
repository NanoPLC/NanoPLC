/* Auto-generated I/O HAL tables — do not edit. */
#include "nanoplc_hal.h"
#include "nanoplc_generated.h"

#include <stddef.h>

static const nanoplc_hal_di_entry_t npgen_di_table[] = {
    { .index = 0, .gpio = 0, .active_high = true },
    { .index = 1, .gpio = 1, .active_high = true }
};
static const size_t npgen_di_table_count = 2;

static const nanoplc_hal_do_entry_t npgen_do_table[] = {
    { .index = 0, .gpio = 2, .active_high = true }
};
static const size_t npgen_do_table_count = 1;

void nanoplc_generated_io_bind(void)
{
    nanoplc_hal_init(npgen_di_table, npgen_di_table_count, npgen_do_table, npgen_do_table_count);
}
