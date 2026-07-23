import type { PlcIr, PlcPrimitiveType, ScheduleStep } from "../types";
import type { IoMap } from "../types";
import { IR_VERSION } from "../constants";
import { codegenIoHalConfig, type CodegenFirmwareOutput, type CodegenIoContext } from "./codegenFirmware";

export interface CodegenCResult {
  plc_program_c: string;
  magic: number;
  ir_sha256_prefix: string;
}

function cIdent(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(safe)) {
    return `v_${safe}`;
  }
  return safe;
}

function cTypeFor(type: PlcPrimitiveType): string {
  switch (type) {
    case "BOOL":
      return "bool";
    case "INT":
      return "int16_t";
    case "DINT":
      return "int32_t";
    case "UINT":
    case "WORD":
      return "uint16_t";
    case "REAL":
      return "float";
    default:
      return "bool";
  }
}

function cLiteral(type: PlcPrimitiveType, value: boolean | number | undefined): string {
  if (type === "BOOL") {
    return value === true || value === 1 ? "true" : "false";
  }
  const n = typeof value === "number" ? value : Number(value);
  const num = Number.isFinite(n) ? n : 0;
  switch (type) {
    case "INT":
      return `${Math.trunc(num)}`;
    case "DINT":
      return `${Math.trunc(num)}L`;
    case "UINT":
    case "WORD":
      return `${Math.trunc(num)}u`;
    case "REAL":
      return Number.isInteger(num) ? `${num}.0f` : `${num}f`;
    default:
      return "0";
  }
}

function varRef(name: string | undefined): string {
  if (!name) {
    return "false";
  }
  return `npgen_v_${cIdent(name)}`;
}

function line(step: ScheduleStep, dtExpr: string): string[] {
  switch (step.op) {
    case "read_di": {
      const idx = step.index ?? 0;
      const out = varRef(step.out ?? step.symbol);
      return [
        `    npgen_di[${idx}] = nanoplc_hal_read_di(${idx});`,
        `    ${out} = npgen_di[${idx}];`,
      ];
    }
    case "read_ai": {
      const idx = step.index ?? 0;
      const out = varRef(step.out ?? step.symbol);
      return [
        `    npgen_ai[${idx}] = nanoplc_hal_read_ai(${idx});`,
        `    ${out} = npgen_ai[${idx}];`,
      ];
    }
    case "write_do": {
      const idx = step.index ?? 0;
      const src = varRef(step.in1);
      const lines = [
        `    npgen_do[${idx}] = ${src};`,
        `    nanoplc_hal_write_do(${idx}, ${src});`,
      ];
      if (step.symbol) {
        lines.push(`    ${varRef(step.symbol)} = ${src};`);
      }
      return lines;
    }
    case "and":
      return [`    ${varRef(step.out)} = (${varRef(step.in1)} && ${varRef(step.in2)});`];
    case "or":
      return [`    ${varRef(step.out)} = (${varRef(step.in1)} || ${varRef(step.in2)});`];
    case "not":
      return [`    ${varRef(step.out)} = !${varRef(step.in1)};`];
    case "ton": {
      const id = cIdent(step.block_id ?? "ton");
      const pt = step.pt_ms ?? 1000;
      const out = varRef(step.out);
      const inn = varRef(step.in1);
      return [
        `    if (${inn}) {`,
        `        if (npgen_ton_${id}.et_ms < ${pt}u) {`,
        `            npgen_ton_${id}.et_ms += ${dtExpr};`,
        `        }`,
        `        npgen_ton_${id}.q = (npgen_ton_${id}.et_ms >= ${pt}u);`,
        `    } else {`,
        `        npgen_ton_${id}.et_ms = 0;`,
        `        npgen_ton_${id}.q = false;`,
        `    }`,
        `    ${out} = npgen_ton_${id}.q;`,
      ];
    }
    case "move":
      return [`    ${varRef(step.out)} = ${varRef(step.in1)};`];
    case "const": {
      const t = step.value_type ?? "BOOL";
      return [`    ${varRef(step.out)} = ${cLiteral(t, step.value)};`];
    }
    default:
      return [`    /* unsupported op ${step.op} */`];
  }
}

function collectTypedVars(ir: PlcIr): { name: string; type: PlcPrimitiveType }[] {
  const byName = new Map<string, PlcPrimitiveType>();
  for (const v of ir.variables) {
    byName.set(v.name, v.type);
  }
  for (const step of ir.schedule) {
    for (const name of [step.out, step.in1, step.in2, step.symbol]) {
      if (name && !byName.has(name)) {
        byName.set(name, step.value_type && name === step.out ? step.value_type : "BOOL");
      }
    }
  }
  return [...byName.entries()]
    .map(([name, type]) => ({ name, type }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function tonBlocks(ir: PlcIr): { id: string; pt_ms: number }[] {
  return ir.schedule
    .filter((s) => s.op === "ton")
    .map((s) => ({ id: cIdent(s.block_id ?? "ton"), pt_ms: s.pt_ms ?? 1000 }));
}

export function computeIrMagic(ir: PlcIr, irSha256Hex: string): number {
  const crc16 = parseInt(irSha256Hex.slice(0, 4), 16) & 0xffff;
  return ((IR_VERSION & 0xff) << 24) | (crc16 << 8) | (IR_VERSION & 0xff);
}

export function codegenC(ir: PlcIr, irSha256Hex: string, _ioMap?: IoMap): CodegenCResult {
  const diCount = Math.max(0, ...ir.io_image.di.map((d) => d.index + 1), 0);
  const aiCount = Math.max(0, ...ir.io_image.ai.map((d) => d.index + 1), 0);
  const doCount = Math.max(0, ...ir.io_image.do.map((d) => d.index + 1), 0);
  const typedVars = collectTypedVars(ir);
  const tons = tonBlocks(ir);
  const magic = computeIrMagic(ir, irSha256Hex);
  const dtExpr = "npgen_scan_dt_ms";

  const varDecls = typedVars
    .map((v) => `static ${cTypeFor(v.type)} npgen_v_${cIdent(v.name)};`)
    .join("\n");
  const tonStructs = tons
    .map((t) => `static struct { uint32_t et_ms; bool q; } npgen_ton_${t.id};`)
    .join("\n");

  const body = ir.schedule.flatMap((step) => line(step, dtExpr)).join("\n");

  const plc_program_c = `/* Auto-generated from IR v${IR_VERSION} — do not edit. */
#include "nanoplc_generated.h"
#include "nanoplc_hal.h"

#include <stdbool.h>
#include <stdint.h>

/* Provided by nanoplc_runtime — forward declare to avoid CMake cycle (generated ↔ runtime). */
uint32_t nanoplc_runtime_scan_period_ms(void);

#define NPGEN_SCAN_DT_MS ${ir.project.scan_period_ms}u

static bool npgen_di[${diCount || 1}];
static float npgen_ai[${aiCount || 1}];
static bool npgen_do[${doCount || 1}];
${varDecls ? `${varDecls}\n` : ""}${tonStructs ? `${tonStructs}\n` : ""}
uint32_t nanoplc_generated_magic(void)
{
    return 0x${magic.toString(16).padStart(8, "0")}u;
}

void nanoplc_generated_program_scan(void)
{
    const uint32_t npgen_scan_dt_ms = nanoplc_runtime_scan_period_ms();

${body}
}
`;

  return {
    plc_program_c,
    magic,
    ir_sha256_prefix: irSha256Hex.slice(0, 16),
  };
}

export function codegenFirmware(
  ir: PlcIr,
  irSha256Hex: string,
  context?: CodegenIoContext
): CodegenFirmwareOutput {
  const core = codegenC(ir, irSha256Hex, context?.ioMap);
  return {
    ...core,
    io_hal_config_c: codegenIoHalConfig(ir, context),
  };
}

export type { CodegenIoContext } from "./codegenFirmware";
