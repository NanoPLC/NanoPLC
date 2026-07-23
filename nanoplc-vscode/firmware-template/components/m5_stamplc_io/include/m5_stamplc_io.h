#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "driver/i2c_master.h"

#ifdef __cplusplus
extern "C" {
#endif

/** StamPLC host internal I2C bus (USER_SCL / USER_SDA). */
#define M5_STAMPLC_IO_SCL_GPIO 15
#define M5_STAMPLC_IO_SDA_GPIO 13

/** REG_IO_CONTROL (0x10) output bits — StamPLC IO I2C protocol V1. */
#define M5_STAMPLC_IO_BIT_EX_CTR_1   0
#define M5_STAMPLC_IO_BIT_EX_CTR_2   1
#define M5_STAMPLC_IO_BIT_RELAY_TRIG 4

typedef struct {
    void *i2c;
    uint8_t i2c_addr;
    uint8_t io_shadow;
    bool ready;
} m5_stamplc_io_t;

/** Initialize the shared StamPLC I2C bus (idempotent). */
esp_err_t m5_stamplc_io_bus_init(void);

/** Shared I2C bus handle (valid after bus init). */
i2c_master_bus_handle_t m5_stamplc_io_bus_handle(void);

/** Bind one expansion module at `i2c_addr` (0x20–0x2F). */
esp_err_t m5_stamplc_io_init(m5_stamplc_io_t *dev, uint8_t i2c_addr);

/** Drive one REG_IO_CONTROL bit (IO mode, not PWM). */
esp_err_t m5_stamplc_io_set_bit(m5_stamplc_io_t *dev, uint8_t bit, bool active_high, bool on);

/** Read bus voltage for analog channel 1 or 2 (millivolts, little-endian at 0x00 / 0x06). */
esp_err_t m5_stamplc_io_read_voltage_mv(m5_stamplc_io_t *dev, uint8_t channel, int16_t *millivolts);

#ifdef __cplusplus
}
#endif
