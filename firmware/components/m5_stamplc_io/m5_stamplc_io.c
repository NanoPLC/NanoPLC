#include "m5_stamplc_io.h"

#include "driver/i2c_master.h"
#include "esp_log.h"

static const char *TAG = "stamplc_io";

#define REG_IO_CONTROL 0x10u
#define REG_V_CH1_LSB  0x00u
#define REG_V_CH2_LSB  0x06u

static i2c_master_bus_handle_t s_bus;
static bool s_bus_ready;

static i2c_master_dev_handle_t dev_handle(m5_stamplc_io_t *dev)
{
    return (i2c_master_dev_handle_t)dev->i2c;
}

static esp_err_t dev_transmit(m5_stamplc_io_t *dev, const uint8_t *data, size_t len)
{
    i2c_master_dev_handle_t handle = dev_handle(dev);
    if (handle == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return i2c_master_transmit(handle, data, len, 1000);
}

static esp_err_t dev_read_reg(m5_stamplc_io_t *dev, uint8_t reg, uint8_t *value)
{
    i2c_master_dev_handle_t handle = dev_handle(dev);
    if (handle == NULL) {
        return ESP_ERR_INVALID_STATE;
    }
    return i2c_master_transmit_receive(handle, &reg, 1, value, 1, 1000);
}

static void dev_release(m5_stamplc_io_t *dev)
{
    i2c_master_dev_handle_t handle = dev_handle(dev);
    if (handle != NULL) {
        i2c_master_bus_rm_device(handle);
        dev->i2c = NULL;
    }
    dev->ready = false;
}

esp_err_t m5_stamplc_io_bus_init(void)
{
    if (s_bus_ready) {
        return ESP_OK;
    }

    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = M5_STAMPLC_IO_SDA_GPIO,
        .scl_io_num = M5_STAMPLC_IO_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags = {
            .enable_internal_pullup = true,
        },
    };

    esp_err_t err = i2c_new_master_bus(&bus_cfg, &s_bus);
    if (err == ESP_OK) {
        s_bus_ready = true;
        ESP_LOGI(TAG, "I2C bus init SCL=%d SDA=%d", M5_STAMPLC_IO_SCL_GPIO, M5_STAMPLC_IO_SDA_GPIO);
    } else {
        ESP_LOGE(TAG, "I2C bus init failed: %s", esp_err_to_name(err));
    }
    return err;
}

i2c_master_bus_handle_t m5_stamplc_io_bus_handle(void)
{
    return s_bus;
}

esp_err_t m5_stamplc_io_init(m5_stamplc_io_t *dev, uint8_t i2c_addr)
{
    if (dev == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (i2c_addr < 0x20 || i2c_addr > 0x2f) {
        ESP_LOGW(TAG, "I2C address 0x%02X outside StamPLC IO range 0x20–0x2F", i2c_addr);
    }

    dev_release(dev);
    dev->i2c_addr = i2c_addr;

    esp_err_t err = m5_stamplc_io_bus_init();
    if (err != ESP_OK) {
        return err;
    }

    i2c_device_config_t cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = i2c_addr,
        .scl_speed_hz = 100000,
    };
    i2c_master_dev_handle_t handle = NULL;
    err = i2c_master_bus_add_device(s_bus, &cfg, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Add device 0x%02X failed: %s", i2c_addr, esp_err_to_name(err));
        return err;
    }
    dev->i2c = handle;

    uint8_t shadow = 0;
    err = dev_read_reg(dev, REG_IO_CONTROL, &shadow);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Module 0x%02X not responding: %s", i2c_addr, esp_err_to_name(err));
        dev_release(dev);
        return err;
    }

    dev->io_shadow = shadow;
    dev->ready = true;
    ESP_LOGI(TAG, "Module 0x%02X online (IO ctrl=0x%02X)", i2c_addr, shadow);
    return ESP_OK;
}

esp_err_t m5_stamplc_io_set_bit(m5_stamplc_io_t *dev, uint8_t bit, bool active_high, bool on)
{
    if (dev == NULL || !dev->ready) {
        return ESP_ERR_INVALID_STATE;
    }

    const bool level = active_high ? on : !on;
    uint8_t next = dev->io_shadow;
    if (level) {
        next = (uint8_t)(next | (1u << bit));
    } else {
        next = (uint8_t)(next & ~(1u << bit));
    }
    /* Force IO mode (clear PWM mode select). */
    next = (uint8_t)(next & ~(1u << 5));

    if (next == dev->io_shadow) {
        return ESP_OK;
    }

    const uint8_t frame[2] = { REG_IO_CONTROL, next };
    esp_err_t err = dev_transmit(dev, frame, sizeof(frame));
    if (err == ESP_OK) {
        dev->io_shadow = next;
    } else {
        ESP_LOGW(TAG, "Write 0x%02X IO ctrl failed: %s", dev->i2c_addr, esp_err_to_name(err));
    }
    return err;
}

esp_err_t m5_stamplc_io_read_voltage_mv(m5_stamplc_io_t *dev, uint8_t channel, int16_t *millivolts)
{
    if (dev == NULL || millivolts == NULL || !dev->ready) {
        return ESP_ERR_INVALID_STATE;
    }
    if (channel != 1 && channel != 2) {
        return ESP_ERR_INVALID_ARG;
    }

    const uint8_t reg = (channel == 1) ? REG_V_CH1_LSB : REG_V_CH2_LSB;
    uint8_t data[2] = {0};
    i2c_master_dev_handle_t handle = dev_handle(dev);
    if (handle == NULL) {
        return ESP_ERR_INVALID_STATE;
    }

    esp_err_t err = i2c_master_transmit_receive(handle, &reg, 1, data, sizeof(data), 1000);
    if (err != ESP_OK) {
        return err;
    }

    *millivolts = (int16_t)((uint16_t)data[0] | ((uint16_t)data[1] << 8));
    return ESP_OK;
}
