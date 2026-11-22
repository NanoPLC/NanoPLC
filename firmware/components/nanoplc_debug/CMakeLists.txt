idf_component_register(
    SRCS "nanoplc_debug.c"
    INCLUDE_DIRS "include"
    REQUIRES nanoplc_generated nanoplc_runtime freertos log
)
