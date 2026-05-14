#include "nanoplc_generated.h"
#include "esp_log.h"

#include <inttypes.h>

static const char *TAG = "np_gen";

uint32_t nanoplc_generated_magic(void)
{
    return NANOPLC_GENERATED_MAGIC_STUB;
}

void nanoplc_generated_program_scan(void)
{
    /* Placeholder: FBD/IR codegen injects real logic here. */
    static uint32_t s_ticks;
    s_ticks++;

    if ((s_ticks % 1000u) == 0u) {
        ESP_LOGD(TAG, "scan stub tick %" PRIu32, s_ticks);
    }
}
