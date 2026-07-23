idf_component_register(
    SRCS "plc_program.c" "io_hal_config.c"
    INCLUDE_DIRS "include"
    REQUIRES log nanoplc_hal m5_stamplc_io m5_aw9523
)
