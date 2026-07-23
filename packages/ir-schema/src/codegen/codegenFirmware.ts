import type { ModuleConfig } from "../moduleCatalog";
import type { IoMap, NanoPlcProject, PlcIr } from "../types";
import { resolveAw9523Bindings, resolveStamPlcIoBindings, type Aw9523DiBinding, type Aw9523DoBinding, type Aw9523DriverBinding, type StamPlcIoDriverBinding } from "./driverBindings";

export interface CodegenIoContext {
  ioMap?: IoMap;
  project?: NanoPlcProject;
  moduleConfigs?: Map<string, ModuleConfig>;
}

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

function stamplcIoBitMacro(bit: number): string {
  switch (bit) {
    case 0:
      return "M5_STAMPLC_IO_BIT_EX_CTR_1";
    case 1:
      return "M5_STAMPLC_IO_BIT_EX_CTR_2";
    case 4:
      return "M5_STAMPLC_IO_BIT_RELAY_TRIG";
    default:
      return String(bit);
  }
}

function emitStamPlcIoDevice(binding: StamPlcIoDriverBinding): string {
  return `static m5_stamplc_io_t ${binding.cDeviceVar};`;
}

function emitStamPlcIoWriter(binding: StamPlcIoDriverBinding, doBinding: StamPlcIoDriverBinding["doBindings"][0], suffix: string): string {
  const fn = `npgen_${binding.cDeviceVar}_do_${suffix}`;
  const bit = stamplcIoBitMacro(doBinding.roleBit);
  const active = doBinding.activeHigh ? "true" : "false";
  return `static void ${fn}(size_t index, bool value)
{
    (void)index;
    (void)m5_stamplc_io_set_bit(&${binding.cDeviceVar}, ${bit}, ${active}, value);
}`;
}

function emitStamPlcIoAiReader(binding: StamPlcIoDriverBinding, aiBinding: StamPlcIoDriverBinding["aiBindings"][0], suffix: string): string {
  const fn = `npgen_${binding.cDeviceVar}_ai_${suffix}`;
  return `static float ${fn}(size_t index)
{
    (void)index;
    int16_t millivolts = 0;
    if (m5_stamplc_io_read_voltage_mv(&${binding.cDeviceVar}, ${aiBinding.channel}, &millivolts) != ESP_OK) {
        return 0.0f;
    }
    return (float)millivolts / 1000.0f;
}`;
}

function emitStamPlcIoSection(bindings: StamPlcIoDriverBinding[]): string {
  if (bindings.length === 0) {
    return "";
  }

  const devices = bindings.map(emitStamPlcIoDevice).join("\n");
  const helpers: string[] = [];
  const inits: string[] = ["    (void)m5_stamplc_io_bus_init();"];
  const registrations: string[] = [];

  for (const binding of bindings) {
    inits.push(
      `    (void)m5_stamplc_io_init(&${binding.cDeviceVar}, 0x${binding.i2cAddress.toString(16)});`
    );
    binding.doBindings.forEach((doBinding, idx) => {
      const suffix = `${doBinding.processIndex}_${idx}`;
      helpers.push(emitStamPlcIoWriter(binding, doBinding, suffix));
      registrations.push(
        `    nanoplc_hal_register_do_writer(${doBinding.processIndex}, npgen_${binding.cDeviceVar}_do_${suffix});`
      );
    });
    binding.aiBindings.forEach((aiBinding, idx) => {
      const suffix = `${aiBinding.processIndex}_${idx}`;
      helpers.push(emitStamPlcIoAiReader(binding, aiBinding, suffix));
      registrations.push(
        `    nanoplc_hal_register_ai_reader(${aiBinding.processIndex}, npgen_${binding.cDeviceVar}_ai_${suffix});`
      );
    });
  }

  return `#include "m5_stamplc_io.h"

${devices}

${helpers.join("\n\n")}

static void npgen_bind_stamplc_io_modules(void)
{
${inits.join("\n")}
${registrations.join("\n")}
}
`;
}

function emitAw9523DiReader(binding: Aw9523DiBinding, suffix: string): string {
  const fn = `npgen_aw9523_di_${suffix}`;
  return `static bool ${fn}(size_t index)
{
    (void)index;
    return m5_aw9523_read_di(${binding.channel});
}`;
}

function emitAw9523DoWriter(binding: Aw9523DoBinding, suffix: string): string {
  const fn = `npgen_aw9523_do_${suffix}`;
  return `static void ${fn}(size_t index, bool value)
{
    (void)index;
    m5_aw9523_write_do(${binding.channel}, value);
}`;
}

function emitAw9523Section(binding: Aw9523DriverBinding | undefined): string {
  if (!binding) {
    return "";
  }

  const helpers: string[] = [];
  const registrations: string[] = [];

  binding.diBindings.forEach((diBinding, idx) => {
    const suffix = `${diBinding.processIndex}_${idx}`;
    helpers.push(emitAw9523DiReader(diBinding, suffix));
    registrations.push(
      `    nanoplc_hal_register_di_reader(${diBinding.processIndex}, npgen_aw9523_di_${suffix});`
    );
  });

  binding.doBindings.forEach((doBinding, idx) => {
    const suffix = `${doBinding.processIndex}_${idx}`;
    helpers.push(emitAw9523DoWriter(doBinding, suffix));
    registrations.push(
      `    nanoplc_hal_register_do_writer(${doBinding.processIndex}, npgen_aw9523_do_${suffix});`
    );
  });

  return `#include "m5_aw9523.h"

${helpers.join("\n\n")}

static void npgen_bind_aw9523(void)
{
    (void)m5_aw9523_init();
${registrations.join("\n")}
}
`;
}

export function codegenIoHalConfig(ir: PlcIr, context?: CodegenIoContext): string {
  const ioMap = context?.ioMap;
  const stamplcBindings =
    context?.project && context.moduleConfigs
      ? resolveStamPlcIoBindings(context.project, ir, ioMap, context.moduleConfigs)
      : [];
  const aw9523Binding =
    context?.project && context.moduleConfigs
      ? resolveAw9523Bindings(context.project, ir, context.moduleConfigs)
      : undefined;

  const stamplcSection = emitStamPlcIoSection(stamplcBindings);
  const aw9523Section = emitAw9523Section(aw9523Binding);
  const bindAw9523Call = aw9523Binding ? "    npgen_bind_aw9523();" : "";
  const bindStamplcCall = stamplcBindings.length > 0 ? "    npgen_bind_stamplc_io_modules();" : "";

  return `/* Auto-generated I/O HAL tables — do not edit. */
#include "nanoplc_hal.h"
#include "nanoplc_generated.h"

#include <stddef.h>

${emitTable("di", diRows(ir, ioMap))}

${emitTable("do", doRows(ir, ioMap))}

${aw9523Section}${stamplcSection}
void nanoplc_generated_io_bind(void)
{
    nanoplc_hal_init(npgen_di_table, npgen_di_table_count, npgen_do_table, npgen_do_table_count);
${bindAw9523Call}
${bindStamplcCall}
}
`;
}

export interface CodegenFirmwareOutput {
  plc_program_c: string;
  io_hal_config_c: string;
  magic: number;
  ir_sha256_prefix: string;
}
