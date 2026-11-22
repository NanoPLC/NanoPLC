#include "nanoplc_debug.h"

#include "nanoplc_generated.h"
#include "nanoplc_runtime.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#include <stdio.h>
#include <string.h>

static const char *TAG = "np_dbg";

#if CONFIG_NANOPLC_DEBUG_TELEMETRY

#define NP_DBG_MAX_PAYLOAD 512
#define NP_DBG_PERIOD_MS 100

static uint32_t s_seq;

static void put_u16(uint8_t *buf, size_t *off, uint16_t v)
{
    buf[(*off)++] = (uint8_t)(v & 0xff);
    buf[(*off)++] = (uint8_t)((v >> 8) & 0xff);
}

static void put_u32(uint8_t *buf, size_t *off, uint32_t v)
{
    buf[(*off)++] = (uint8_t)(v & 0xff);
    buf[(*off)++] = (uint8_t)((v >> 8) & 0xff);
    buf[(*off)++] = (uint8_t)((v >> 16) & 0xff);
    buf[(*off)++] = (uint8_t)((v >> 24) & 0xff);
}

static void put_f32(uint8_t *buf, size_t *off, float v)
{
    uint32_t u;
    memcpy(&u, &v, sizeof(u));
    put_u32(buf, off, u);
}

static void put_bits(uint8_t *buf, size_t *off, size_t count, bool (*peek)(size_t))
{
    const size_t bytes = (count + 7u) / 8u;
    for (size_t b = 0; b < bytes; b++) {
        uint8_t byte = 0;
        for (size_t bit = 0; bit < 8; bit++) {
            const size_t idx = b * 8u + bit;
            if (idx < count && peek(idx)) {
                byte |= (uint8_t)(1u << bit);
            }
        }
        buf[(*off)++] = byte;
    }
}

static bool build_payload(uint8_t *buf, size_t *out_len)
{
    size_t off = 0;
    size_t var_count = 0;
    const nanoplc_var_meta_t *vars = nanoplc_generated_var_meta(&var_count);
    const size_t di_count = nanoplc_generated_di_count();
    const size_t do_count = nanoplc_generated_do_count();
    const size_t ai_count = nanoplc_generated_ai_count();

    if (di_count > 32 || do_count > 32 || ai_count > 16 || var_count > 64) {
        return false;
    }

    put_u32(buf, &off, nanoplc_generated_magic());
    put_u32(buf, &off, s_seq++);
    put_u32(buf, &off, 0); /* scan_index reserved; IDE uses seq */
    buf[off++] = (uint8_t)di_count;
    buf[off++] = (uint8_t)do_count;
    buf[off++] = (uint8_t)ai_count;
    buf[off++] = (uint8_t)var_count;

    put_bits(buf, &off, di_count, nanoplc_generated_peek_di);
    put_bits(buf, &off, do_count, nanoplc_generated_peek_do);
    for (size_t i = 0; i < ai_count; i++) {
        put_f32(buf, &off, nanoplc_generated_peek_ai(i));
    }

    for (size_t i = 0; i < var_count; i++) {
        const nanoplc_var_meta_t *v = &vars[i];
        const char *name = v->name ? v->name : "";
        size_t nlen = strlen(name);
        if (nlen > 32) {
            nlen = 32;
        }
        if (off + 2 + nlen + 4 >= NP_DBG_MAX_PAYLOAD) {
            return false;
        }
        buf[off++] = (uint8_t)nlen;
        memcpy(buf + off, name, nlen);
        off += nlen;
        buf[off++] = (uint8_t)v->type;
        switch (v->type) {
        case NANOPLC_VT_BOOL:
            buf[off++] = v->addr && *(const bool *)v->addr ? 1u : 0u;
            break;
        case NANOPLC_VT_INT:
        case NANOPLC_VT_UINT:
        case NANOPLC_VT_WORD: {
            uint16_t raw = 0;
            if (v->addr) {
                memcpy(&raw, v->addr, sizeof(raw));
            }
            put_u16(buf, &off, raw);
            break;
        }
        case NANOPLC_VT_DINT: {
            uint32_t raw = 0;
            if (v->addr) {
                memcpy(&raw, v->addr, sizeof(raw));
            }
            put_u32(buf, &off, raw);
            break;
        }
        case NANOPLC_VT_REAL:
            put_f32(buf, &off, v->addr ? *(const float *)v->addr : 0.0f);
            break;
        default:
            buf[off++] = 0;
            break;
        }
    }

    uint8_t x = 0;
    for (size_t i = 0; i < off; i++) {
        x ^= buf[i];
    }
    put_u16(buf, &off, x);
    *out_len = off;
    return true;
}

static void emit_line(const uint8_t *buf, size_t len)
{
    /* Printable framing so ESP_LOG lines and telemetry share one UART. */
    fputs("#NP1 ", stdout);
    for (size_t i = 0; i < len; i++) {
        printf("%02x", buf[i]);
    }
    fputc('\n', stdout);
    fflush(stdout);
}

static void debug_task(void *arg)
{
    (void)arg;
    uint8_t payload[NP_DBG_MAX_PAYLOAD];
    for (;;) {
        size_t len = 0;
        if (build_payload(payload, &len)) {
            emit_line(payload, len);
        }
        vTaskDelay(pdMS_TO_TICKS(NP_DBG_PERIOD_MS));
    }
}

void nanoplc_debug_init(void)
{
    const BaseType_t ok =
        xTaskCreate(debug_task, "np_dbg", 3072, NULL, tskIDLE_PRIORITY + 1, NULL);
    if (ok != pdPASS) {
        ESP_LOGW(TAG, "failed to start debug telemetry task");
        return;
    }
    ESP_LOGI(TAG, "UART telemetry enabled (#NP1 every %d ms)", NP_DBG_PERIOD_MS);
}

#else

void nanoplc_debug_init(void)
{
    ESP_LOGI(TAG, "UART telemetry disabled (CONFIG_NANOPLC_DEBUG_TELEMETRY=n)");
}

#endif
