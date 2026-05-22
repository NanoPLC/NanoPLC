import type { IoMap, PlcIr } from "../types";

interface HalRow {
  index: number;
  gpio: number;
  active_high: boolean;
}

function diRows(ir: PlcIr, ioMap?: IoMap): HalRow[] {
  return ir.io_image.di.map((d) => {
    const mapped = ioMap?.entries.find((e) => e.kind === "DI" && e.symbol === d.symbol);
    return {
      index: d.index,
      gpio: mapped?.gpio ?? -1,
      active_high: mapped?.active_high ?? true,
    };
  });
}

function doRows(ir: PlcIr, ioMap?: IoMap): HalRow[] {
  return ir.io_image.do.map((d) => {
    const mapped = ioMap?.entries.find((e) => e.kind === "DO" && e.symbol === d.symbol);
    return {
      index: d.index,
      gpio: mapped?.gpio ?? -1,
      active_high: mapped?.active_high ?? true,
    };
  });
}

function emitTable(kind: "di" | "do", rows: HalRow[]): string {
  const type = kind === "di" ? "nanoplc_hal_di_entry_t" : "nanoplc_hal_do_entry_t";
  const name = kind === "di" ? "npgen_di_table" : "npgen_do_table";
  if (rows.length === 0) {
    return `static const ${type} ${name}[] = {};\nstatic const size_t ${name}_count = 0;`;
  }
  const body = rows
    .map(
      (r) =>
        `    { .index = ${r.index}, .gpio = ${r.gpio}, .active_high = ${r.active_high ? "true" : "false"} }`
    )
    .join(",\n");
  return `static const ${type} ${name}[] = {\n${body}\n};\nstatic const size_t ${name}_count = ${rows.length};`;
}

export function codegenIoHalConfig(ir: PlcIr, ioMap?: IoMap): string {
  return `/* Auto-generated I/O HAL tables — do not edit. */
#include "nanoplc_hal.h"
#include "nanoplc_generated.h"

#include <stddef.h>

${emitTable("di", diRows(ir, ioMap))}

${emitTable("do", doRows(ir, ioMap))}

void nanoplc_generated_io_bind(void)
{
    nanoplc_hal_init(npgen_di_table, npgen_di_table_count, npgen_do_table, npgen_do_table_count);
}
`;
}

export interface CodegenFirmwareOutput {
  plc_program_c: string;
  io_hal_config_c: string;
  magic: number;
  ir_sha256_prefix: string;
}
