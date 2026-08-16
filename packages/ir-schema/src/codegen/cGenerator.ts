import type { PlcIr, PlcPrimitiveType, ScheduleStep } from "../types";
import type { IoMap } from "../types";
import { IR_VERSION } from "../constants";
import { pouIrName } from "../pouVars";
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

function bitMask(type: PlcPrimitiveType): number {
  return type === "DINT" ? 31 : 15;
}

function numericBinOp(
  step: ScheduleStep,
  op: string,
  floatOp?: string
): string[] {
  const t = step.value_type ?? "REAL";
  const a = varRef(step.in1);
  const b = varRef(step.in2);
  const out = varRef(step.out);
  if (t === "REAL") {
    const oper = floatOp ?? op;
    if (oper === "/") {
      return [`    ${out} = (${b} != 0.0f) ? (${a} ${oper} ${b}) : 0.0f;`];
    }
    return [`    ${out} = ${a} ${oper} ${b};`];
  }
  if (operIsDiv(op)) {
    const cast = t === "DINT" ? "int32_t" : t === "INT" ? "int16_t" : "uint16_t";
    return [`    ${out} = (${b} != 0) ? ((${cast})(${a} / ${b})) : 0;`];
  }
  if (t === "DINT" || t === "INT") {
    return [`    ${out} = ${a} ${op} ${b};`];
  }
  return [`    ${out} = (uint16_t)(${a} ${op} ${b});`];
}

function operIsDiv(op: string): boolean {
  return op === "/";
}

function numericShiftOp(step: ScheduleStep, op: "shl" | "shr"): string[] {
  const t = step.value_type ?? "WORD";
  const a = varRef(step.in1);
  const n = varRef(step.in2);
  const out = varRef(step.out);
  const mask = bitMask(t);
  if (t === "DINT") {
    const shift = op === "shl" ? "<<" : ">>";
    return [`    ${out} = (int32_t)((uint32_t)${a} ${shift} (${n} & ${mask}u));`];
  }
  const shift = op === "shl" ? "<<" : ">>";
  return [`    ${out} = (uint16_t)((uint16_t)${a} ${shift} (${n} & ${mask}u));`];
}

function numericRotateOp(step: ScheduleStep, op: "rol" | "ror"): string[] {
  const t = step.value_type ?? "WORD";
  const a = varRef(step.in1);
  const n = varRef(step.in2);
  const out = varRef(step.out);
  if (t === "DINT") {
    const width = 32;
    const mask = 31;
    if (op === "rol") {
      return [
        `    { uint32_t _v = (uint32_t)${a}; uint32_t _n = (uint32_t)(${n} & ${mask}u); ${out} = (int32_t)((_v << _n) | (_v >> (${width}u - _n))); }`,
      ];
    }
    return [
      `    { uint32_t _v = (uint32_t)${a}; uint32_t _n = (uint32_t)(${n} & ${mask}u); ${out} = (int32_t)((_v >> _n) | (_v << (${width}u - _n))); }`,
    ];
  }
  const width = 16;
  const mask = 15;
  if (op === "rol") {
    return [
      `    { uint16_t _v = (uint16_t)${a}; uint16_t _n = (uint16_t)(${n} & ${mask}u); ${out} = (uint16_t)((_v << _n) | (_v >> (${width}u - _n))); }`,
    ];
  }
  return [
    `    { uint16_t _v = (uint16_t)${a}; uint16_t _n = (uint16_t)(${n} & ${mask}u); ${out} = (uint16_t)((_v >> _n) | (_v << (${width}u - _n))); }`,
  ];
}

function bitSetOp(step: ScheduleStep, set: boolean): string[] {
  const t = step.value_type ?? "WORD";
  const a = varRef(step.in1);
  const bit = varRef(step.in2);
  const out = varRef(step.out);
  const mask = bitMask(t);
  if (t === "DINT") {
    const expr = set
      ? `${a} | (1L << (${bit} & ${mask}u))`
      : `${a} & ~(1L << (${bit} & ${mask}u))`;
    return [`    ${out} = ${expr};`];
  }
  const expr = set
    ? `(uint16_t)(${a} | (1u << (${bit} & ${mask}u)))`
    : `(uint16_t)(${a} & ~(1u << (${bit} & ${mask}u)))`;
  return [`    ${out} = ${expr};`];
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
    case "rs": {
      const id = cIdent(step.block_id ?? "rs");
      const out = varRef(step.out);
      const set = varRef(step.in1);
      const reset1 = varRef(step.in2);
      return [
        `    if (${reset1}) {`,
        `        npgen_rs_${id}.q = false;`,
        `    } else if (${set}) {`,
        `        npgen_rs_${id}.q = true;`,
        `    }`,
        `    ${out} = npgen_rs_${id}.q;`,
      ];
    }
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
    case "add":
      return numericBinOp(step, "+");
    case "sub":
      return numericBinOp(step, "-");
    case "mul":
      return numericBinOp(step, "*");
    case "div":
      return numericBinOp(step, "/");
    case "pow":
      return [
        `    ${varRef(step.out)} = powf((float)${varRef(step.in1)}, (float)${varRef(step.in2)});`,
      ];
    case "sqrt":
      return [`    ${varRef(step.out)} = sqrtf((float)${varRef(step.in1)});`];
    case "setbit":
      return bitSetOp(step, true);
    case "resetbit":
      return bitSetOp(step, false);
    case "shl":
      return numericShiftOp(step, "shl");
    case "shr":
      return numericShiftOp(step, "shr");
    case "rol":
      return numericRotateOp(step, "rol");
    case "ror":
      return numericRotateOp(step, "ror");
    case "call": {
      const id = cIdent(step.program ?? "pou");
      const lines: string[] = [];
      for (const [port, src] of Object.entries(step.call_in ?? {})) {
        const dest = pouIrName(step.program ?? "pou", port);
        lines.push(`    ${varRef(dest)} = ${varRef(src)};`);
      }
      lines.push(`    npgen_pou_${id}();`);
      for (const [port, dest] of Object.entries(step.call_out ?? {})) {
        const src = pouIrName(step.program ?? "pou", port);
        lines.push(`    ${varRef(dest)} = ${varRef(src)};`);
      }
      return lines;
    }
    default:
      return [`    /* unsupported op ${step.op} */`];
  }
}

function allSteps(ir: PlcIr): ScheduleStep[] {
  const extra = ir.pou_schedules?.flatMap((p) => p.schedule) ?? [];
  return [...ir.schedule, ...extra];
}

function collectTypedVars(ir: PlcIr): { name: string; type: PlcPrimitiveType; initial?: boolean | number }[] {
  const byName = new Map<string, { type: PlcPrimitiveType; initial?: boolean | number }>();
  for (const v of ir.variables) {
    byName.set(v.name, { type: v.type, initial: v.initial });
  }
  for (const step of allSteps(ir)) {
    for (const name of [step.out, step.in1, step.in2, step.symbol]) {
      if (name && !byName.has(name)) {
        byName.set(name, {
          type: step.value_type && name === step.out ? step.value_type : "BOOL",
        });
      }
    }
    for (const name of Object.values(step.call_in ?? {})) {
      if (name && !byName.has(name)) {
        byName.set(name, { type: "BOOL" });
      }
    }
    for (const name of Object.values(step.call_out ?? {})) {
      if (name && !byName.has(name)) {
        byName.set(name, { type: "BOOL" });
      }
    }
  }
  return [...byName.entries()]
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function uniqueById<T extends { id: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    out.push(row);
  }
  return out;
}

function tonBlocks(ir: PlcIr): { id: string; pt_ms: number }[] {
  return uniqueById(
    allSteps(ir)
      .filter((s) => s.op === "ton")
      .map((s) => ({ id: cIdent(s.block_id ?? "ton"), pt_ms: s.pt_ms ?? 1000 }))
  );
}

function rsBlocks(ir: PlcIr): { id: string }[] {
  return uniqueById(
    allSteps(ir)
      .filter((s) => s.op === "rs")
      .map((s) => ({ id: cIdent(s.block_id ?? "rs") }))
  );
}

function usesMathLib(ir: PlcIr): boolean {
  return allSteps(ir).some((s) => s.op === "pow" || s.op === "sqrt");
}

export function computeIrMagic(_ir: PlcIr, irSha256Hex: string): number {
  const crc16 = parseInt(irSha256Hex.slice(0, 4), 16) & 0xffff;
  return ((IR_VERSION & 0xff) << 24) | (crc16 << 8) | (IR_VERSION & 0xff);
}

export function codegenC(ir: PlcIr, irSha256Hex: string, _ioMap?: IoMap): CodegenCResult {
  const diCount = Math.max(0, ...ir.io_image.di.map((d) => d.index + 1), 0);
  const aiCount = Math.max(0, ...ir.io_image.ai.map((d) => d.index + 1), 0);
  const doCount = Math.max(0, ...ir.io_image.do.map((d) => d.index + 1), 0);
  const typedVars = collectTypedVars(ir);
  const tons = tonBlocks(ir);
  const rss = rsBlocks(ir);
  const magic = computeIrMagic(ir, irSha256Hex);
  const dtExpr = "npgen_scan_dt_ms";
  const needMath = usesMathLib(ir);

  const varDecls = typedVars
    .map((v) => {
      const init =
        v.initial === undefined ? "" : ` = ${cLiteral(v.type, v.initial)}`;
      return `static ${cTypeFor(v.type)} npgen_v_${cIdent(v.name)}${init};`;
    })
    .join("\n");
  const tonStructs = tons
    .map((t) => `static struct { uint32_t et_ms; bool q; } npgen_ton_${t.id};`)
    .join("\n");
  const rsStructs = rss.map((r) => `static struct { bool q; } npgen_rs_${r.id};`).join("\n");

  const pous = ir.pou_schedules ?? [];
  const pouProtos = pous
    .map((p) => `static void npgen_pou_${cIdent(p.id)}(void);`)
    .join("\n");
  const pouFns = pous
    .map((p) => {
      const pouBody = p.schedule.flatMap((step) => line(step, dtExpr)).join("\n");
      return `static void npgen_pou_${cIdent(p.id)}(void)\n{\n${pouBody}\n}`;
    })
    .join("\n\n");
  const body = ir.schedule.flatMap((step) => line(step, dtExpr)).join("\n");
  const needsDt = tons.length > 0;
  const dtDecl = needsDt && pous.length > 0 ? "static uint32_t npgen_scan_dt_ms;\n" : "";
  const scanDt = !needsDt
    ? ""
    : pous.length > 0
      ? "    npgen_scan_dt_ms = nanoplc_runtime_scan_period_ms();\n\n"
      : "    const uint32_t npgen_scan_dt_ms = nanoplc_runtime_scan_period_ms();\n\n";
  const scanPeriodProto = needsDt
    ? `/* Provided by nanoplc_runtime — forward declare to avoid CMake cycle (generated ↔ runtime). */
uint32_t nanoplc_runtime_scan_period_ms(void);

`
    : "";

  const plc_program_c = `/* Auto-generated from IR v${IR_VERSION} — do not edit. */
#include "nanoplc_generated.h"
#include "nanoplc_hal.h"

#include <stdbool.h>
#include <stdint.h>
${needMath ? "#include <math.h>\n" : ""}
${scanPeriodProto}${diCount > 0 ? `static bool npgen_di[${diCount}];\n` : ""}${aiCount > 0 ? `static float npgen_ai[${aiCount}];\n` : ""}${doCount > 0 ? `static bool npgen_do[${doCount}];\n` : ""}${varDecls ? `${varDecls}\n` : ""}${tonStructs ? `${tonStructs}\n` : ""}${rsStructs ? `${rsStructs}\n` : ""}${dtDecl}${pouProtos ? `${pouProtos}\n` : ""}
uint32_t nanoplc_generated_magic(void)
{
    return 0x${magic.toString(16).padStart(8, "0")}u;
}
${pouFns ? `\n${pouFns}\n` : ""}
void nanoplc_generated_program_scan(void)
{
${scanDt}${body}
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
