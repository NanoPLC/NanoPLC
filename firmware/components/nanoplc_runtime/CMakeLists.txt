idf_component_register(
    SRCS "nanoplc_runtime.c"
    INCLUDE_DIRS "include"
    REQUIRES nanoplc_generated nanoplc_core freertos esp_system esp_timer log
)
