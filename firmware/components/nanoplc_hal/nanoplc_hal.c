#include "nanoplc_hal.h"

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include <string.h>

static const char *TAG = "np_hal";

static const nanoplc_hal_di_entry_t *s_di_table;
static size_t s_di_count;
static const nanoplc_hal_do_entry_t *s_do_table;
static size_t s_do_count;

static bool s_do_shadow[NANOPLC_HAL_MAX_DO];
static nanoplc_hal_do_write_fn s_do_writers[NANOPLC_HAL_MAX_DO];
static nanoplc_hal_di_read_fn s_di_readers[NANOPLC_HAL_MAX_DI];
static nanoplc_hal_ai_read_fn s_ai_readers[NANOPLC_HAL_MAX_AI];
static bool s_failsafe_outputs_off;

/* PLC tasks preempt each other; expander drivers read-modify-write shared registers. */
static StaticSemaphore_t s_lock_buf;
static SemaphoreHandle_t s_lock;

static void hal_lock(void)
{
    if (s_lock != NULL) {
        xSemaphoreTake(s_lock, portMAX_DELAY);
    }
}

static void hal_unlock(void)
{
    if (s_lock != NULL) {
        xSemaphoreGive(s_lock);
    }
}

static const nanoplc_hal_di_entry_t *find_di(size_t index)
{
    for (size_t i = 0; i < s_di_count; i++) {
        if (s_di_table[i].index == index) {
            return &s_di_table[i];
        }
    }
    return NULL;
}

static const nanoplc_hal_do_entry_t *find_do(size_t index)
{
    for (size_t i = 0; i < s_do_count; i++) {
        if (s_do_table[i].index == index) {
            return &s_do_table[i];
        }
    }
    return NULL;
}

static bool gpio_level(int gpio, bool active_high, bool logical_on)
{
    const int level = logical_on ? (active_high ? 1 : 0) : (active_high ? 0 : 1);
    return gpio_set_level((gpio_num_t)gpio, level) == ESP_OK;
}

void nanoplc_hal_init(const nanoplc_hal_di_entry_t *di, size_t di_count,
                      const nanoplc_hal_do_entry_t *do_entries, size_t do_count)
{
    if (s_lock == NULL) {
        s_lock = xSemaphoreCreateMutexStatic(&s_lock_buf);
    }
    s_di_table = di;
    s_di_count = di_count;
    s_do_table = do_entries;
    s_do_count = do_count;
    memset(s_do_shadow, 0, sizeof(s_do_shadow));
    memset(s_do_writers, 0, sizeof(s_do_writers));
    memset(s_di_readers, 0, sizeof(s_di_readers));
    memset(s_ai_readers, 0, sizeof(s_ai_readers));
    s_failsafe_outputs_off = false;

    for (size_t i = 0; i < di_count; i++) {
        const nanoplc_hal_di_entry_t *e = &di[i];
        if (e->gpio < 0) {
            continue;
        }
        gpio_config_t cfg = {
            .pin_bit_mask = (1ULL << e->gpio),
            .mode = GPIO_MODE_INPUT,
            .pull_up_en = e->active_high ? GPIO_PULLUP_DISABLE : GPIO_PULLUP_ENABLE,
            .pull_down_en = e->active_high ? GPIO_PULLDOWN_ENABLE : GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        esp_err_t err = gpio_config(&cfg);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "DI gpio %d config failed: %s", e->gpio, esp_err_to_name(err));
        }
    }

    for (size_t i = 0; i < do_count; i++) {
        const nanoplc_hal_do_entry_t *e = &do_entries[i];
        if (e->gpio < 0) {
            continue;
        }
        gpio_config_t cfg = {
            .pin_bit_mask = (1ULL << e->gpio),
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        esp_err_t err = gpio_config(&cfg);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "DO gpio %d config failed: %s", e->gpio, esp_err_to_name(err));
            continue;
        }
        gpio_level(e->gpio, e->active_high, false);
    }

    ESP_LOGI(TAG, "HAL init: %u DI, %u DO mapped", (unsigned)di_count, (unsigned)do_count);
}

void nanoplc_hal_register_do_writer(size_t index, nanoplc_hal_do_write_fn fn)
{
    if (index < NANOPLC_HAL_MAX_DO) {
        s_do_writers[index] = fn;
    }
}

void nanoplc_hal_register_di_reader(size_t index, nanoplc_hal_di_read_fn fn)
{
    if (index < NANOPLC_HAL_MAX_DI) {
        s_di_readers[index] = fn;
    }
}

void nanoplc_hal_register_ai_reader(size_t index, nanoplc_hal_ai_read_fn fn)
{
    if (index < NANOPLC_HAL_MAX_AI) {
        s_ai_readers[index] = fn;
    }
}

static bool read_di_unlocked(size_t index)
{
    if (index < NANOPLC_HAL_MAX_DI && s_di_readers[index] != NULL) {
        return s_di_readers[index](index);
    }

    const nanoplc_hal_di_entry_t *e = find_di(index);
    if (e == NULL || e->gpio < 0) {
        return false;
    }
    const int raw = gpio_get_level((gpio_num_t)e->gpio);
    return e->active_high ? (raw != 0) : (raw == 0);
}

bool nanoplc_hal_read_di(size_t index)
{
    hal_lock();
    const bool value = read_di_unlocked(index);
    hal_unlock();
    return value;
}

static void write_do_unlocked(size_t index, bool value)
{
    if (index < NANOPLC_HAL_MAX_DO) {
        s_do_shadow[index] = value;
    }

    const nanoplc_hal_do_entry_t *e = find_do(index);
    if (e != NULL && e->gpio < 0 && index < NANOPLC_HAL_MAX_DO && s_do_writers[index] != NULL) {
        s_do_writers[index](index, value);
        return;
    }
    if (e == NULL || e->gpio < 0) {
        return;
    }
    gpio_level(e->gpio, e->active_high, value);
}

void nanoplc_hal_write_do(size_t index, bool value)
{
    hal_lock();
    if (s_failsafe_outputs_off) {
        hal_unlock();
        return;
    }
    write_do_unlocked(index, value);
    hal_unlock();
}

void nanoplc_hal_force_outputs_off(void)
{
    hal_lock();
    s_failsafe_outputs_off = true;
    for (size_t i = 0; i < s_do_count; i++) {
        write_do_unlocked(s_do_table[i].index, false);
    }
    for (size_t i = 0; i < NANOPLC_HAL_MAX_DO; i++) {
        if (s_do_writers[i] != NULL) {
            write_do_unlocked(i, false);
        }
    }
    hal_unlock();
    ESP_LOGW(TAG, "fail-safe: all digital outputs forced OFF");
}

float nanoplc_hal_read_ai(size_t index)
{
    float value = 0.0f;
    hal_lock();
    if (index < NANOPLC_HAL_MAX_AI && s_ai_readers[index] != NULL) {
        value = s_ai_readers[index](index);
    }
    hal_unlock();
    return value;
}
