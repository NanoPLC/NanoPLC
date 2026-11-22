#include "nanoplc_wrap.h"

int16_t nanoplc_wrap_i16(int32_t value) {
  return (int16_t)value;
}

int32_t nanoplc_wrap_i32(int64_t value) {
  return (int32_t)value;
}

uint16_t nanoplc_wrap_u16(int32_t value) {
  return (uint16_t)value;
}
