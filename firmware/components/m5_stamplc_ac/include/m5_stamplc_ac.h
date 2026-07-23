#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

/** StamPLC AC PI4IOE5V6408 7-bit I2C address (fixed). */
#define M5_STAMPLC_AC_I2C_ADDR 0x44

/** Relay enable pin on the expander (REL_EN / P2). */
#define M5_STAMPLC_AC_PIN_RELAY 2

/** Initialize StamPLC AC relay output (uses StamPLC internal I2C bus). */
esp_err_t m5_stamplc_ac_init(void);

bool m5_stamplc_ac_is_ready(void);

/** Drive AC relay channel 0 (only channel on this module). */
void m5_stamplc_ac_write_do(uint8_t channel, bool value);
