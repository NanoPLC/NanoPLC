#include "m5_stamplc_ac.h"

#include "driver/i2c_master.h"
#include "esp_log.h"
#include "m5_stamplc_io.h"

static const char *TAG = "stamplc_ac";

#define PI4IOE_REG_CHIP_ID   0x01u
#define PI4IOE_REG_DIRECTION 0x03u
#define PI4IOE_REG_OUTPUT    0x05u
#define PI4IOE_REG_HIZ       0x07u
#define PI4IOE_REG_PULL_EN   0x0Bu
#define PI4IOE_REG_PULL_SEL  0x0Du

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

static esp_err_t update_reg_bit(uint8_t reg, uint8_t mask, bool set)
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

static esp_err_t configure_relay_output(void)
{
    const uint8_t pin = M5_STAMPLC_AC_PIN_RELAY;
    const uint8_t mask = (uint8_t)(1u << pin);
    esp_err_t err;

    err = update_reg_bit(PI4IOE_REG_DIRECTION, mask, true);
    if (err != ESP_OK) {
        return err;
    }
    err = update_reg_bit(PI4IOE_REG_PULL_EN, mask, false);
    if (err != ESP_OK) {
        return err;
    }
    err = update_reg_bit(PI4IOE_REG_PULL_SEL, mask, false);
    if (err != ESP_OK) {
        return err;
    }
    err = update_reg_bit(PI4IOE_REG_HIZ, mask, false);
    if (err != ESP_OK) {
        return err;
    }
    return update_reg_bit(PI4IOE_REG_OUTPUT, mask, false);
}

esp_err_t m5_stamplc_ac_init(void)
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
        .device_address = M5_STAMPLC_AC_I2C_ADDR,
        .scl_speed_hz = 400000,
    };
    err = i2c_master_bus_add_device(m5_stamplc_io_bus_handle(), &cfg, &s_dev);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Add device 0x%02X failed: %s", M5_STAMPLC_AC_I2C_ADDR, esp_err_to_name(err));
        return err;
    }

    uint8_t chip_id = 0;
    err = read_reg8(PI4IOE_REG_CHIP_ID, &chip_id);
    if (err != ESP_OK || chip_id == 0) {
        ESP_LOGE(TAG, "PI4IOE5V6408 not found (id=0x%02X)", chip_id);
        if (s_dev != NULL) {
            i2c_master_bus_rm_device(s_dev);
            s_dev = NULL;
        }
        return err != ESP_OK ? err : ESP_ERR_NOT_FOUND;
    }

    err = configure_relay_output();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Relay pin config failed: %s", esp_err_to_name(err));
        i2c_master_bus_rm_device(s_dev);
        s_dev = NULL;
        return err;
    }

    s_ready = true;
    ESP_LOGI(TAG, "StamPLC AC online at 0x%02X (relay P%d)", M5_STAMPLC_AC_I2C_ADDR, M5_STAMPLC_AC_PIN_RELAY);
    return ESP_OK;
}

bool m5_stamplc_ac_is_ready(void)
{
    return s_ready;
}

void m5_stamplc_ac_write_do(uint8_t channel, bool value)
{
    if (!s_ready || channel != 0) {
        return;
    }

    const uint8_t mask = (uint8_t)(1u << M5_STAMPLC_AC_PIN_RELAY);
    (void)update_reg_bit(PI4IOE_REG_OUTPUT, mask, value);
}
