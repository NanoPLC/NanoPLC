idf_component_register(
    SRCS "nanoplc_hal.c"
    INCLUDE_DIRS "include"
    REQUIRES driver freertos log
)
