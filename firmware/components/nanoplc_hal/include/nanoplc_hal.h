#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint8_t index;
    int gpio;
    bool active_high;
} nanoplc_hal_di_entry_t;

typedef struct {
    uint8_t index;
    int gpio;
    bool active_high;
} nanoplc_hal_do_entry_t;

void nanoplc_hal_init(const nanoplc_hal_di_entry_t *di, size_t di_count,
                      const nanoplc_hal_do_entry_t *do_entries, size_t do_count);

bool nanoplc_hal_read_di(size_t index);

void nanoplc_hal_write_do(size_t index, bool value);

#ifdef __cplusplus
}
#endif
