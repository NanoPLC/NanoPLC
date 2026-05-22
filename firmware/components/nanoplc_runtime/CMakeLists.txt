idf_component_register(
    SRCS "nanoplc_runtime.c"
    INCLUDE_DIRS "include"
    REQUIRES nanoplc_generated freertos esp_system esp_timer log
)
