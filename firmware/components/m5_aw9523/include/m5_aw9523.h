#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/** StamPLC onboard AW9523B 7-bit I2C address. */
#define M5_AW9523_I2C_ADDR 0x59

/** Initialize onboard AW9523 (8 DI / 4 relay DO). Uses StamPLC internal I2C bus. */
esp_err_t m5_aw9523_init(void);

bool m5_aw9523_is_ready(void);

/** Read PLC input channel 0–7 (maps to AW9523 pins per StamPLC wiring). */
bool m5_aw9523_read_di(uint8_t channel);

/** Write relay channel 0–3. */
void m5_aw9523_write_do(uint8_t channel, bool value);
