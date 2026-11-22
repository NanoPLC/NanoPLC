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

typedef void (*nanoplc_hal_do_write_fn)(size_t index, bool value);
typedef bool (*nanoplc_hal_di_read_fn)(size_t index);
typedef float (*nanoplc_hal_ai_read_fn)(size_t index);

#define NANOPLC_HAL_MAX_DO 32
#define NANOPLC_HAL_MAX_DI 32
#define NANOPLC_HAL_MAX_AI 32

void nanoplc_hal_init(const nanoplc_hal_di_entry_t *di, size_t di_count,
                      const nanoplc_hal_do_entry_t *do_entries, size_t do_count);

/** Register an alternate DO writer for process-image indices without GPIO (e.g. I2C expanders). */
void nanoplc_hal_register_do_writer(size_t index, nanoplc_hal_do_write_fn fn);

/** Register an alternate DI reader for process-image indices without GPIO. */
void nanoplc_hal_register_di_reader(size_t index, nanoplc_hal_di_read_fn fn);

/** Register an alternate AI reader for process-image indices without ADC/GPIO. */
void nanoplc_hal_register_ai_reader(size_t index, nanoplc_hal_ai_read_fn fn);

bool nanoplc_hal_read_di(size_t index);

void nanoplc_hal_write_do(size_t index, bool value);

/**
 * Watchdog fail-safe: force every mapped DO OFF and ignore further writes
 * until the next reboot (docs/VIRTUAL_PLC_PLAN.md §33.3).
 */
void nanoplc_hal_force_outputs_off(void);

/** Read analog process-image value (REAL). Returns 0.0 when unmapped. */
float nanoplc_hal_read_ai(size_t index);

#ifdef __cplusplus
}
#endif
