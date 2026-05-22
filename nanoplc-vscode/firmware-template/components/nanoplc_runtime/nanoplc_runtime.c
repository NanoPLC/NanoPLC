#include "nanoplc_runtime.h"
#include "nanoplc_generated.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <inttypes.h>

static const char *TAG = "np_rt";

static uint32_t s_scan_period_ms;

static void nanoplc_scan_task(void *unused)
{
    (void)unused;

    TickType_t period_ticks = pdMS_TO_TICKS(s_scan_period_ms);
    if (period_ticks == 0) {
        period_ticks = 1;
    }

    esp_err_t twdt_res = esp_task_wdt_add(xTaskGetCurrentTaskHandle());
    if (twdt_res != ESP_OK) {
        ESP_LOGW(TAG, "esp_task_wdt_add failed (%s)", esp_err_to_name(twdt_res));
    }

    TickType_t next = xTaskGetTickCount();

    for (;;) {
        esp_task_wdt_reset();

        int64_t t0_us = esp_timer_get_time();

        nanoplc_generated_program_scan();

        int64_t t1_us = esp_timer_get_time();
        const int64_t elapsed_us = t1_us - t0_us;
        const uint32_t budget_us = s_scan_period_ms * 1000u;
        if (budget_us != 0u && elapsed_us > (int64_t)budget_us) {
            ESP_LOGW(TAG, "scan overrun %" PRId64 " us (budget %" PRIu32 " us)", elapsed_us, budget_us);
        }

        vTaskDelayUntil(&next, period_ticks);
    }
}

void nanoplc_runtime_init(uint32_t scan_period_ms)
{
    s_scan_period_ms = (scan_period_ms > 0u) ? scan_period_ms : 10u;

    ESP_LOGI(
        TAG,
        "init PLC scan (ABI v%u): period=%" PRIu32 " ms magic=0x%08" PRIX32,
        (unsigned)NANOPLC_RUNTIME_ABI_VERSION,
        s_scan_period_ms,
        nanoplc_generated_magic()
    );

    nanoplc_generated_io_bind();

    const BaseType_t status = xTaskCreatePinnedToCore(
        nanoplc_scan_task,
        "np_scan",
        4096,
        NULL,
        configMAX_PRIORITIES - 2,
        NULL,
        tskNO_AFFINITY
    );

    if (status != pdPASS) {
        ESP_LOGE(TAG, "failed to create plc scan task");
    }
}

uint32_t nanoplc_runtime_scan_period_ms(void)
{
    return s_scan_period_ms;
}
