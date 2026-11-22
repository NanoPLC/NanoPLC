#include "nanoplc_runtime.h"
#include "nanoplc_generated.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include <inttypes.h>
#include <stdio.h>

static const char *TAG = "np_rt";

#define NP_TOP_PRIORITY (configMAX_PRIORITIES - 2)
#define NP_TASK_STACK 4096

#if CONFIG_FREERTOS_UNICORE
#define NP_PLC_CORE 0
#else
#define NP_PLC_CORE 1
#endif

static uint32_t s_scan_period_ms;

static UBaseType_t freertos_priority(uint8_t plc_priority)
{
    const int prio = (int)NP_TOP_PRIORITY - (int)plc_priority;
    return (UBaseType_t)(prio < 1 ? 1 : prio);
}

/** Whole milliseconds since `*last_us`; keeps the sub-millisecond remainder for the next pass. */
static uint32_t take_elapsed_ms(int64_t now_us, int64_t *last_us)
{
    const int64_t ms = (now_us - *last_us) / 1000;
    *last_us += ms * 1000;
    return ms > 0 ? (uint32_t)ms : 0u;
}

static uint32_t ticks_to_ms(TickType_t ticks)
{
    return (uint32_t)(((uint64_t)ticks * 1000u) / configTICK_RATE_HZ);
}

#define NP_OVERRUN_LOG_INTERVAL_US 1000000

/** Logs at most once per second per task; `*suppressed` counts the overruns not logged. */
static void check_overrun(const nanoplc_task_desc_t *t, int64_t start_us, int64_t end_us, int64_t *last_log_us,
                          uint32_t *suppressed)
{
    const int64_t elapsed_us = end_us - start_us;
    const int64_t interval_us = (t->kind == NANOPLC_TASK_CYCLIC) ? (int64_t)t->interval_ms * 1000 : 0;
    const int64_t watchdog_us = (int64_t)t->watchdog_ms * 1000;
    const bool over_interval = interval_us != 0 && elapsed_us > interval_us;
    const bool over_watchdog = watchdog_us != 0 && elapsed_us > watchdog_us;
    if (!over_interval && !over_watchdog) {
        return;
    }
    if (*last_log_us != 0 && end_us - *last_log_us < NP_OVERRUN_LOG_INTERVAL_US) {
        (*suppressed)++;
        return;
    }
    *last_log_us = end_us;
    ESP_LOGW(TAG, "task %s %s: pass took %" PRId64 " us (limit %" PRId64 " us, %" PRIu32 " more since last log)",
             t->id, over_watchdog ? "exceeded watchdog" : "overrun", elapsed_us,
             over_watchdog ? watchdog_us : interval_us, *suppressed);
    *suppressed = 0;
}

static void plc_task(void *arg)
{
    const nanoplc_task_desc_t *t = (const nanoplc_task_desc_t *)arg;
    const bool cyclic = (t->kind == NANOPLC_TASK_CYCLIC);

    TickType_t period_ticks = cyclic ? pdMS_TO_TICKS(t->interval_ms) : 1;
    if (period_ticks == 0) {
        period_ticks = 1;
    }

    esp_err_t twdt_res = esp_task_wdt_add(NULL);
    if (twdt_res != ESP_OK) {
        ESP_LOGW(TAG, "task %s: esp_task_wdt_add failed (%s)", t->id, esp_err_to_name(twdt_res));
    }

    TickType_t release = xTaskGetTickCount();
    int64_t last_us = esp_timer_get_time();
    uint32_t dt_ms = cyclic ? t->interval_ms : 0u;
    int64_t last_log_us = 0;
    uint32_t suppressed = 0;

    for (;;) {
        esp_task_wdt_reset();

        const int64_t t0_us = esp_timer_get_time();
        if (!cyclic) {
            dt_ms = take_elapsed_ms(t0_us, &last_us);
        }

        t->run(dt_ms);

        check_overrun(t, t0_us, esp_timer_get_time(), &last_log_us, &suppressed);

        if (cyclic) {
            const TickType_t prev = release;
            if (xTaskDelayUntil(&release, period_ticks) == pdFALSE) {
                /* Deadline missed: skip the lost passes and let timers see the real elapsed time. */
                release = xTaskGetTickCount();
                dt_ms = ticks_to_ms(release - prev);
            } else {
                dt_ms = t->interval_ms;
            }
        } else {
            vTaskDelay(1);
        }
    }
}

void nanoplc_runtime_init(void)
{
    size_t count = 0;
    const nanoplc_task_desc_t *tasks = nanoplc_generated_tasks(&count);

    s_scan_period_ms = 0;
    for (size_t i = 0; i < count; i++) {
        if (tasks[i].primary && tasks[i].kind == NANOPLC_TASK_CYCLIC) {
            s_scan_period_ms = tasks[i].interval_ms;
        }
    }

    ESP_LOGI(TAG, "init PLC runtime (ABI v%u): %u task(s), tick %u Hz, magic=0x%08" PRIX32,
             (unsigned)NANOPLC_RUNTIME_ABI_VERSION, (unsigned)count, (unsigned)configTICK_RATE_HZ,
             nanoplc_generated_magic());

    nanoplc_generated_io_bind();

    for (size_t i = 0; i < count; i++) {
        const nanoplc_task_desc_t *t = &tasks[i];
        if (t->kind == NANOPLC_TASK_EVENT) {
            ESP_LOGW(TAG, "task %s: event tasks are not supported yet, not started", t->id);
            continue;
        }
        if (t->kind == NANOPLC_TASK_CYCLIC && ((t->interval_ms * configTICK_RATE_HZ) % 1000u) != 0u) {
            ESP_LOGW(TAG, "task %s: interval %" PRIu32 " ms is not a multiple of the %u Hz tick", t->id,
                     t->interval_ms, (unsigned)configTICK_RATE_HZ);
        }

        char name[configMAX_TASK_NAME_LEN];
        snprintf(name, sizeof(name), "np_%s", t->id);
        const UBaseType_t prio = freertos_priority(t->priority);
        const BaseType_t status =
            xTaskCreatePinnedToCore(plc_task, name, NP_TASK_STACK, (void *)t, prio, NULL, NP_PLC_CORE);
        if (status != pdPASS) {
            ESP_LOGE(TAG, "task %s: xTaskCreate failed", t->id);
            continue;
        }
        ESP_LOGI(TAG, "task %s: %s, %" PRIu32 " ms, PLC prio %u -> RTOS prio %u, core %d", t->id,
                 t->kind == NANOPLC_TASK_CYCLIC ? "cyclic" : "freewheeling", t->interval_ms,
                 (unsigned)t->priority, (unsigned)prio, NP_PLC_CORE);
    }
}

uint32_t nanoplc_runtime_scan_period_ms(void)
{
    return s_scan_period_ms;
}
