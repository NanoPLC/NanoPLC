#include "m5_aw9523.h"

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "m5_stamplc_io.h"

#include <string.h>

static const char *TAG = "aw9523";

#define AW9523_REG_INPUT0   0x00
#define AW9523_REG_OUTPUT0  0x02
#define AW9523_REG_CONFIG0  0x04
#define AW9523_REG_GCR      0x11
#define AW9523_REG_LEDMODE  0x12
#define AW9523_REG_CHIPID   0x10

/** StamPLC wiring: DI 1–4 on P0_4..P0_7, DI 5–8 on P1_4..P1_7. */
static const uint8_t s_di_pins[8] = {4, 5, 6, 7, 12, 13, 14, 15};
static const uint8_t s_do_pins[4] = {0, 1, 2, 3};

static i2c_master_dev_handle_t s_dev;
static bool s_ready;

static esp_err_t write_reg8(uint8_t reg, uint8_t value)
{
    if (s_dev == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    const uint8_t frame[2] = {reg, value};
    return i2c_master_transmit(s_dev, frame, sizeof(frame), 1000);
}

static esp_err_t read_reg8(uint8_t reg, uint8_t *value)
{
    if (s_dev == NULL || value == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    return i2c_master_transmit_receive(s_dev, &reg, 1, value, 1, 1000);
}

static esp_err_t update_reg8(uint8_t reg, uint8_t mask, bool set)
{
    uint8_t value = 0;
    esp_err_t err = read_reg8(reg, &value);
    if (err != ESP_OK) {
        return err;
    }
    if (set) {
        value = (uint8_t)(value | mask);
    } else {
        value = (uint8_t)(value & (uint8_t)~mask);
    }
    return write_reg8(reg, value);
}

static void pin_mode_output(uint8_t pin)
{
    update_reg8(AW9523_REG_CONFIG0 + (pin / 8), (uint8_t)(1u << (pin % 8)), false);
    update_reg8(AW9523_REG_LEDMODE + (pin / 8), (uint8_t)(1u << (pin % 8)), true);
}

static void pin_mode_input(uint8_t pin)
{
    update_reg8(AW9523_REG_CONFIG0 + (pin / 8), (uint8_t)(1u << (pin % 8)), true);
    update_reg8(AW9523_REG_LEDMODE + (pin / 8), (uint8_t)(1u << (pin % 8)), true);
}

static bool pin_read(uint8_t pin)
{
    uint8_t reg = AW9523_REG_INPUT0 + (pin / 8);
    uint8_t value = 0;
    if (read_reg8(reg, &value) != ESP_OK) {
        return false;
    }
    return (value & (1u << (pin % 8))) != 0;
}

static void pin_write(uint8_t pin, bool level)
{
    update_reg8(AW9523_REG_OUTPUT0 + (pin / 8), (uint8_t)(1u << (pin % 8)), level);
}

esp_err_t m5_aw9523_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }

    esp_err_t err = m5_stamplc_io_bus_init();
    if (err != ESP_OK) {
        return err;
    }

    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = M5_AW9523_I2C_ADDR,
        .scl_speed_hz = 400000,
    };
    err = i2c_master_bus_add_device(m5_stamplc_io_bus_handle(), &cfg, &s_dev);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Add device 0x%02X failed: %s", M5_AW9523_I2C_ADDR, esp_err_to_name(err));
        return err;
    }

    uint8_t chip_id = 0;
    err = read_reg8(AW9523_REG_CHIPID, &chip_id);
    if (err != ESP_OK || chip_id != 0x23) {
        ESP_LOGE(TAG, "AW9523 not found (id=0x%02X)", chip_id);
        if (s_dev != NULL) {
            i2c_master_bus_rm_device(s_dev);
            s_dev = NULL;
        }
        return err != ESP_OK ? err : ESP_ERR_NOT_FOUND;
    }

    /* All inputs initially (configureDirection(0) in M5 library). */
    write_reg8(AW9523_REG_CONFIG0, 0xFF);
    write_reg8(AW9523_REG_CONFIG0 + 1, 0xFF);
    /* Push-pull on port 0 (relays). */
    update_reg8(AW9523_REG_GCR, (uint8_t)(1u << 4), true);

    for (size_t i = 0; i < 4; i++) {
        pin_mode_output(s_do_pins[i]);
        pin_write(s_do_pins[i], false);
    }
    for (size_t i = 0; i < 8; i++) {
        pin_mode_input(s_di_pins[i]);
    }

    s_ready = true;
    ESP_LOGI(TAG, "AW9523 online at 0x%02X", M5_AW9523_I2C_ADDR);
    return ESP_OK;
}

bool m5_aw9523_is_ready(void)
{
    return s_ready;
}

bool m5_aw9523_read_di(uint8_t channel)
{
    if (!s_ready || channel >= 8) {
        return false;
    }
    return pin_read(s_di_pins[channel]);
}

void m5_aw9523_write_do(uint8_t channel, bool value)
{
    if (!s_ready || channel >= 4) {
        return;
    }
    pin_write(s_do_pins[channel], value);
}
