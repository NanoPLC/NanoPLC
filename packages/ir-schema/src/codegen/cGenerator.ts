import type { IrTask, PlcIr, PlcPrimitiveType, ScheduleStep } from "../types";
import type { IoMap } from "../types";
import { IR_VERSION } from "../constants";
import { irTaskList } from "../irTasks";
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

/** C identifier of an IR variable in `plc_program.c`. */
export function cVarName(name: string): string {
  return `npgen_v_${cIdent(name)}`;
}

/** C identifier of a TON / TOF / TP state struct in `plc_program.c`. */
export function cTimerName(blockId: string): string {
  return `npgen_tmr_${cIdent(blockId)}`;
}

export function cTypeFor(type: PlcPrimitiveType): string {
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
  return cVarName(name);
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
  if (t === "DINT") {
    if (operIsDiv(op)) {
      return [
        `    ${out} = (${b} == 0) ? 0 : (${b} == -1) ? (int32_t)(0u - (uint32_t)${a}) : (int32_t)(${a} / ${b});`,
      ];
    }
    return [`    ${out} = (int32_t)((uint32_t)${a} ${op} (uint32_t)${b});`];
  }
  const cast = t === "INT" ? "int16_t" : "uint16_t";
  if (operIsDiv(op)) {
    return [`    ${out} = (${b} != 0) ? ((${cast})(${a} / ${b})) : 0;`];
  }
  return [`    ${out} = (${cast})(${a} ${op} ${b});`];
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
  const [uType, sType, width, mask] =
    t === "DINT" ? ["uint32_t", "int32_t", 32, 31] : ["uint16_t", t === "INT" ? "int16_t" : "uint16_t", 16, 15];
  const [fwd, back] = op === "rol" ? ["<<", ">>"] : [">>", "<<"];
  return [
    `    { ${uType} _v = (${uType})${a}; uint32_t _n = (uint32_t)${n} & ${mask}u; ${out} = (${sType})(${uType})((_v ${fwd} _n) | (_v ${back} ((${width}u - _n) & ${mask}u))); }`,
  ];
}

function bitSetOp(step: ScheduleStep, set: boolean): string[] {
  const t = step.value_type ?? "WORD";
  const a = varRef(step.in1);
  const bit = varRef(step.in2);
  const out = varRef(step.out);
  const mask = bitMask(t);
  const [uType, sType] = t === "DINT" ? ["uint32_t", "int32_t"] : ["uint16_t", t === "INT" ? "int16_t" : "uint16_t"];
  const bitExpr = `((${uType})1u << ((uint32_t)${bit} & ${mask}u))`;
  const expr = set
    ? `(${sType})(${uType})((${uType})${a} | ${bitExpr})`
    : `(${sType})(${uType})((${uType})${a} & (${uType})~${bitExpr})`;
  return [`    ${out} = ${expr};`];
}

const TIMER_OPS = new Set<ScheduleStep["op"]>(["ton", "tof", "tp"]);

/** Mirrors `executeTimer` in the TS simulator (docs/BLOCK_SEMANTICS.md). */
function timerLines(step: ScheduleStep, dtExpr: string): string[] {
  const s = cTimerName(step.block_id ?? step.op);
  const pt = `${step.pt_ms ?? 1000}u`;
  const out = varRef(step.out);
  const inn = varRef(step.in1);
  const advance = `        ${s}.et_ms = npgen_et_advance(${s}.et_ms, ${dtExpr}, ${pt});`;
  let body: string[];
  switch (step.op) {
    case "ton":
      body = [
        `    if (${inn}) {`,
        advance,
        `        ${s}.q = (${s}.et_ms >= ${pt});`,
        `    } else {`,
        `        ${s}.et_ms = 0;`,
        `        ${s}.q = false;`,
        `    }`,
      ];
      break;
    case "tof":
      body = [
        `    if (${inn}) {`,
        `        ${s}.et_ms = 0;`,
        `        ${s}.q = true;`,
        `    } else if (${s}.q) {`,
        advance,
        `        ${s}.q = (${s}.et_ms < ${pt});`,
        `    }`,
      ];
      break;
    default:
      body = [
        `    if (!${s}.q && ${inn} && !${s}.in_prev) {`,
        `        ${s}.q = true;`,
        `        ${s}.et_ms = 0;`,
        `    }`,
        `    if (${s}.q) {`,
        advance,
        `        ${s}.q = (${s}.et_ms < ${pt});`,
        `    } else if (!${inn}) {`,
        `        ${s}.et_ms = 0;`,
        `    }`,
      ];
      break;
  }
  return [...body, `    ${s}.in_prev = ${inn};`, `    ${out} = ${s}.q;`];
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
    case "ton":
    case "tof":
    case "tp":
      return timerLines(step, dtExpr);
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
      lines.push(`    npgen_pou_${id}(${dtExpr});`);
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
  const tasks = irTaskList(ir).flatMap((t) => t.schedule);
  const extra = ir.pou_schedules?.flatMap((p) => p.schedule) ?? [];
  return [...tasks, ...extra];
}

/** C name of the static function that runs one pass of a PLC task. */
export function cTaskFnName(taskId: string): string {
  return `npgen_task_${cIdent(taskId)}`;
}

const TASK_KIND_C: Record<IrTask["kind"], string> = {
  cyclic: "NANOPLC_TASK_CYCLIC",
  freewheeling: "NANOPLC_TASK_FREEWHEELING",
  event: "NANOPLC_TASK_EVENT",
};

const VAR_TYPE_C: Record<PlcPrimitiveType, string> = {
  BOOL: "NANOPLC_VT_BOOL",
  INT: "NANOPLC_VT_INT",
  UINT: "NANOPLC_VT_UINT",
  WORD: "NANOPLC_VT_WORD",
  DINT: "NANOPLC_VT_DINT",
  REAL: "NANOPLC_VT_REAL",
};

function cString(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, "?")}"`;
}

function cFunction(signature: string, steps: ScheduleStep[], dtExpr: string): string {
  const body = steps.flatMap((step) => line(step, dtExpr));
  return [signature, "{", `    (void)${dtExpr};`, ...body, "}"].join("\n");
}

/** Every variable `plc_program.c` declares, with its PLC type. */
export function collectTypedVars(ir: PlcIr): { name: string; type: PlcPrimitiveType; initial?: boolean | number }[] {
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

function timerBlocks(ir: PlcIr): { id: string }[] {
  return uniqueById(
    allSteps(ir)
      .filter((s) => TIMER_OPS.has(s.op))
      .map((s) => ({ id: cIdent(s.block_id ?? s.op) }))
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
  const timers = timerBlocks(ir);
  const rss = rsBlocks(ir);
  const magic = computeIrMagic(ir, irSha256Hex);
  const dtExpr = "npgen_dt_ms";
  const needMath = usesMathLib(ir);
  const tasks = irTaskList(ir);

  const varDecls = typedVars
    .map((v) => {
      const init =
        v.initial === undefined ? "" : ` = ${cLiteral(v.type, v.initial)}`;
      return `static ${cTypeFor(v.type)} npgen_v_${cIdent(v.name)}${init};`;
    })
    .join("\n");
  const timerStructs = timers.length
    ? [
        ...timers.map(
          (t) => `static struct { uint32_t et_ms; bool q; bool in_prev; } npgen_tmr_${t.id};`
        ),
        "",
        "static inline uint32_t npgen_et_advance(uint32_t et_ms, uint32_t dt_ms, uint32_t pt_ms)",
        "{",
        "    return (dt_ms >= pt_ms - et_ms) ? pt_ms : et_ms + dt_ms;",
        "}",
      ].join("\n")
    : "";
  const rsStructs = rss.map((r) => `static struct { bool q; } npgen_rs_${r.id};`).join("\n");

  const pous = ir.pou_schedules ?? [];
  const pouSig = (id: string) => `static void npgen_pou_${cIdent(id)}(uint32_t ${dtExpr})`;
  const pouProtos = pous.map((p) => `${pouSig(p.id)};`).join("\n");
  const pouFns = pous.map((p) => cFunction(pouSig(p.id), p.schedule, dtExpr)).join("\n\n");
  const taskFns = tasks
    .map((t) => cFunction(`static void ${cTaskFnName(t.id)}(uint32_t ${dtExpr})`, t.schedule, dtExpr))
    .join("\n\n");
  const taskRows = tasks
    .map((t) => {
      const interval = t.kind === "cyclic" ? (t.interval_ms ?? 0) : 0;
      const wdAction =
        t.watchdog_action === "outputs_off" ? "NANOPLC_WATCHDOG_OUTPUTS_OFF" : "NANOPLC_WATCHDOG_HOLD";
      let eventKind = "NANOPLC_EVENT_NONE";
      let eventDi = "0u";
      let eventVar = "NULL";
      if (t.kind === "event" && t.event_source?.kind === "di") {
        eventKind = "NANOPLC_EVENT_DI";
        eventDi = `${t.event_source.index}u`;
      } else if (t.kind === "event" && t.event_source?.kind === "var") {
        eventKind = "NANOPLC_EVENT_VAR";
        eventVar = `&npgen_v_${cIdent(t.event_source.name)}`;
      }
      return `    { ${cString(t.id)}, ${TASK_KIND_C[t.kind]}, ${t.priority}u, ${interval}u, ${t.watchdog_ms ?? 0}u, ${wdAction}, ${t.primary ? "true" : "false"}, ${eventKind}, ${eventDi}, ${eventVar}, ${cTaskFnName(t.id)} },`;
    })
    .join("\n");

  const varMetaRows = typedVars
    .map((v) => `    { ${cString(v.name)}, ${VAR_TYPE_C[v.type]}, &npgen_v_${cIdent(v.name)} },`)
    .join("\n");

  const plc_program_c = `/* Auto-generated from IR v${IR_VERSION} — do not edit. */
#include "nanoplc_generated.h"
#include "nanoplc_hal.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
${needMath ? "#include <math.h>\n" : ""}
${diCount > 0 ? `static bool npgen_di[${diCount}];\n` : ""}${aiCount > 0 ? `static float npgen_ai[${aiCount}];\n` : ""}${doCount > 0 ? `static bool npgen_do[${doCount}];\n` : ""}${varDecls ? `${varDecls}\n` : ""}${timerStructs ? `${timerStructs}\n` : ""}${rsStructs ? `${rsStructs}\n` : ""}${pouProtos ? `${pouProtos}\n` : ""}
uint32_t nanoplc_generated_magic(void)
{
    return 0x${magic.toString(16).padStart(8, "0")}u;
}
${pouFns ? `\n${pouFns}\n` : ""}
${taskFns}

static const nanoplc_task_desc_t npgen_tasks[] = {
${taskRows}
};

const nanoplc_task_desc_t *nanoplc_generated_tasks(size_t *out_count)
{
    *out_count = sizeof(npgen_tasks) / sizeof(npgen_tasks[0]);
    return npgen_tasks;
}

${
  typedVars.length > 0
    ? `static const nanoplc_var_meta_t npgen_var_meta[] = {\n${varMetaRows}\n};\n`
    : ""
}
const nanoplc_var_meta_t *nanoplc_generated_var_meta(size_t *out_count)
{
    ${
      typedVars.length > 0
        ? `*out_count = sizeof(npgen_var_meta) / sizeof(npgen_var_meta[0]);\n    return npgen_var_meta;`
        : `*out_count = 0;\n    return NULL;`
    }
}

size_t nanoplc_generated_di_count(void) { return ${diCount}u; }
size_t nanoplc_generated_do_count(void) { return ${doCount}u; }
size_t nanoplc_generated_ai_count(void) { return ${aiCount}u; }

bool nanoplc_generated_peek_di(size_t index)
{
    ${diCount > 0 ? `return index < ${diCount}u && npgen_di[index];` : "((void)index); return false;"}
}

bool nanoplc_generated_peek_do(size_t index)
{
    ${doCount > 0 ? `return index < ${doCount}u && npgen_do[index];` : "((void)index); return false;"}
}

float nanoplc_generated_peek_ai(size_t index)
{
    ${aiCount > 0 ? `return index < ${aiCount}u ? npgen_ai[index] : 0.0f;` : "((void)index); return 0.0f;"}
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
