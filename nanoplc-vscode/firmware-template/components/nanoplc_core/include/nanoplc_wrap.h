#ifndef NANOPLC_WRAP_H
#define NANOPLC_WRAP_H

#include <stdint.h>

/** Two's-complement wrap matching the TypeScript simulator (`toInt`). */
int16_t nanoplc_wrap_i16(int32_t value);
int32_t nanoplc_wrap_i32(int64_t value);
uint16_t nanoplc_wrap_u16(int32_t value);

#endif
