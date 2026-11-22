/* Stub until first NanoPLC compile/codegen — do not edit. */
#include "nanoplc_generated.h"

const nanoplc_task_desc_t *nanoplc_generated_tasks(size_t *out_count)
{
    *out_count = 0;
    return NULL;
}

uint32_t nanoplc_generated_magic(void)
{
    return NANOPLC_GENERATED_MAGIC_STUB;
}

const nanoplc_var_meta_t *nanoplc_generated_var_meta(size_t *out_count)
{
    *out_count = 0;
    return NULL;
}

size_t nanoplc_generated_di_count(void) { return 0; }
size_t nanoplc_generated_do_count(void) { return 0; }
size_t nanoplc_generated_ai_count(void) { return 0; }
bool nanoplc_generated_peek_di(size_t index) { (void)index; return false; }
bool nanoplc_generated_peek_do(size_t index) { (void)index; return false; }
float nanoplc_generated_peek_ai(size_t index) { (void)index; return 0.0f; }
