#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nanoplc_debug.h"
#include "nanoplc_runtime.h"

static const char *TAG = "np_main";

void app_main(void)
{
    ESP_LOGI(TAG, "NanoPLC firmware boot (%s)", CONFIG_IDF_TARGET);

    nanoplc_runtime_init();
    nanoplc_debug_init();

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        ESP_LOGI(TAG, "idle heartbeat");
    }
}
