import { IR_VERSION } from "./constants";
import type {
  CompileDiagnostic,
  CompileResult,
  FbdBlock,
  FbdVariable,
  FbdWire,
  IoMap,
  IoMapEntry,
  IrEventSource,
  IrVariable,
  NanoPlcProject,
  NanoPlcTaskRef,
  PlcIr,
  PlcPrimitiveType,
  ScheduleStep,
} from "./types";
import {
  buildBlockOutputTypes,
  inferInputPortType,
  inputPortsForBlock,
  isBlockOutputPort,
  blockOutputType,
  parseConstDataType,
  typesCompatible,
  type FbdPortContext,
} from "./fbdPortTypes";
import { PLC_PRIMITIVE_TYPES } from "./types";
import {
  primaryCyclicTask,
  projectScanPeriodMs,
  resolveTaskConfiguration,
  taskEntryProgramId,
} from "./tasks";
import { compileStToIr, stProgramInterface } from "./st/compileSt";
import { validateFbdSource } from "./validate";
import {
  callPortIrName,
  defaultPouInitial,
  findPouVariable,
  parsePouVariables,
  pouIrName,
  pouInterfaceInputs,
  pouInterfaceOutputs,
} from "./pouVars";
import { fbdOutputVar, fbdSourcePortIrName, resolveIoSymbol } from "./fbdIrNames";

const SUPPORTED_BLOCKS = new Set([
  "DI",
  "AI",
  "DO",
  "AND",
  "OR",
  "NOT",
  "TON",
  "TOF",
  "TP",
  "CONST",
  "RS",
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "POW",
  "SQRT",
  "SETBIT",
  "RESETBIT",
  "SHL",
  "SHR",
  "ROL",
  "ROR",
  "CALL",
  "FB",
  "LOCAL",
]);

const TIMER_BLOCKS = new Set(["TON", "TOF", "TP"]);

const DEFAULT_TIMER_PT_MS = 1000;

function rawTimerPt(block: FbdBlock): unknown {
  return block.params?.pt_ms ?? block.params?.PT;
}

function timerPtMs(block: FbdBlock): number {
  const raw = rawTimerPt(block);
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return DEFAULT_TIMER_PT_MS;
  }
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : DEFAULT_TIMER_PT_MS;
}

function validateTimerBlocks(blocks: FbdBlock[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const block of blocks) {
    const t = block.type.toUpperCase();
    if (!TIMER_BLOCKS.has(t)) {
      continue;
    }
    const raw = rawTimerPt(block);
    if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
      continue;
    }
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
      diagnostics.push(
        diag(
          "NP-0220",
          `${t} block "${block.id}" has invalid PT "${String(raw)}". Use a whole number of milliseconds ≥ 0.`,
          block.id
        )
      );
    }
  }
  return diagnostics;
}

function diag(
  code: string,
  message: string,
  block_id?: string
): CompileDiagnostic {
  return { code, message, severity: "error", block_id };
}

function blockById(blocks: FbdBlock[]): Map<string, FbdBlock> {
  return new Map(blocks.map((b) => [b.id, b]));
}

function defaultConstValue(dataType: PlcPrimitiveType): boolean | number {
  return dataType === "BOOL" ? false : 0;
}

function parseBoolLike(v: unknown): boolean {
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return v !== 0;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "on";
  }
  return false;
}

function parseNumericLike(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  if (typeof v === "boolean") {
    return v ? 1 : 0;
  }
  return undefined;
}

function constValueInRange(dataType: PlcPrimitiveType, value: number): boolean {
  switch (dataType) {
    case "INT":
      return Number.isInteger(value) && value >= -32768 && value <= 32767;
    case "DINT":
      return Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    case "UINT":
    case "WORD":
      return Number.isInteger(value) && value >= 0 && value <= 65535;
    case "REAL":
      return Number.isFinite(value);
    default:
      return true;
  }
}

function parseConstValue(
  params: FbdBlock["params"],
  dataType: PlcPrimitiveType
): { ok: true; value: boolean | number } | { ok: false; message: string } {
  if (dataType === "BOOL") {
    if (params?.value === undefined || params.value === null) {
      return { ok: true, value: false };
    }
    return { ok: true, value: parseBoolLike(params.value) };
  }

  if (
    params?.value === undefined ||
    params.value === null ||
    (typeof params.value === "string" && params.value.trim() === "")
  ) {
    return { ok: true, value: defaultConstValue(dataType) as number };
  }

  const num = parseNumericLike(params.value);
  if (num === undefined) {
    return { ok: false, message: `Constant value must be a number for type ${dataType}.` };
  }
  if (!constValueInRange(dataType, num)) {
    return { ok: false, message: `Constant value ${num} is out of range for type ${dataType}.` };
  }
  return { ok: true, value: dataType === "REAL" ? num : Math.trunc(num) };
}

function validateWires(
  blocks: Map<string, FbdBlock>,
  wires: FbdWire[],
  outputTypes: Map<string, PlcPrimitiveType>,
  ctx?: FbdPortContext
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const wire of wires) {
    const fromBlock = blocks.get(wire.from.block);
    const toBlock = blocks.get(wire.to.block);
    if (!fromBlock) {
      diagnostics.push(diag("NP-0300", `Wire references unknown block "${wire.from.block}".`));
      continue;
    }
    if (!toBlock) {
      diagnostics.push(diag("NP-0301", `Wire references unknown block "${wire.to.block}".`));
      continue;
    }
    if (!isBlockOutputPort(fromBlock, wire.from.port, ctx)) {
      diagnostics.push(
        diag("NP-0302", `Port "${wire.from.port}" is not an output on block ${fromBlock.id}.`, fromBlock.id)
      );
    }
    const allowedIn = inputPortsForBlock(toBlock, ctx);
    if (!allowedIn.has(wire.to.port.toUpperCase())) {
      diagnostics.push(
        diag(
          "NP-0303",
          `Invalid input port "${wire.to.port}" on ${toBlock.type} block ${toBlock.id}.`,
          toBlock.id
        )
      );
    }

    const fromType = blockOutputType(fromBlock, wire.from.port, outputTypes, ctx);
    const toType = inferInputPortType(toBlock, wire.to.port, outputTypes, ctx);
    if (!typesCompatible(fromType, toType)) {
      diagnostics.push(
        diag(
          "NP-0305",
          `Type mismatch: ${fromBlock.type} output is ${fromType}, but ${toBlock.type}.${wire.to.port} expects ${toType}.`,
          toBlock.id
        )
      );
    }
  }
  return diagnostics;
}

function validateConstBlocks(blocks: FbdBlock[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const block of blocks) {
    if (block.type.toUpperCase() !== "CONST") {
      continue;
    }
    const rawType = String(block.params?.data_type ?? block.params?.type ?? "BOOL").toUpperCase();
    if (!(PLC_PRIMITIVE_TYPES as readonly string[]).includes(rawType)) {
      diagnostics.push(
        diag(
          "NP-0215",
          `Unsupported constant type "${rawType}". Use one of: ${PLC_PRIMITIVE_TYPES.join(", ")}.`,
          block.id
        )
      );
      continue;
    }
    const dataType = rawType as PlcPrimitiveType;
    const parsed = parseConstValue(block.params, dataType);
    if (!parsed.ok) {
      diagnostics.push(diag("NP-0215", parsed.message, block.id));
    }
  }
  return diagnostics;
}

/** Kahn topological sort; returns order or cycle participant ids. */
function topoSort(
  blockIds: string[],
  edges: Map<string, Set<string>>
): { order?: string[]; cycle?: string[] } {
  const inDegree = new Map<string, number>();
  for (const id of blockIds) {
    inDegree.set(id, 0);
  }
  for (const [, targets] of edges) {
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
    }
  }

  const queue = blockIds.filter((id) => (inDegree.get(id) ?? 0) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of edges.get(n) ?? []) {
      const d = (inDegree.get(m) ?? 0) - 1;
      inDegree.set(m, d);
      if (d === 0) {
        queue.push(m);
      }
    }
  }

  if (order.length !== blockIds.length) {
    const stuck = blockIds.filter((id) => !order.includes(id));
    return { cycle: stuck };
  }
  return { order };
}

function parseChannel(params: FbdBlock["params"]): number | undefined {
  if (params?.channel === undefined || params.channel === null) {
    return undefined;
  }
  const n = typeof params.channel === "number" ? params.channel : Number(params.channel);
  return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

function resolveIoIndex(
  block: FbdBlock,
  kind: "DI" | "DO" | "AI",
  ioBySymbol: Map<string, IoMapEntry>,
  autoIndex: number
): { symbol: string; index: number; nextAuto: number } {
  const symbol = resolveIoSymbol(block, kind);
  const mapped = ioBySymbol.get(symbol);
  if (mapped) {
    return { symbol, index: mapped.index, nextAuto: autoIndex };
  }
  const channel = parseChannel(block.params);
  if (channel !== undefined) {
    return { symbol, index: channel - 1, nextAuto: autoIndex };
  }
  return { symbol, index: autoIndex, nextAuto: autoIndex + 1 };
}

function validateIoBindings(blocks: FbdBlock[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const diSymbols = new Map<string, string>();
  const aiSymbols = new Map<string, string>();
  const doSymbols = new Map<string, string>();

  for (const block of blocks) {
    const t = block.type.toUpperCase();
    if (t !== "DI" && t !== "AI" && t !== "DO") {
      continue;
    }
    const channel = parseChannel(block.params);
    const label = t === "DI" ? "Digital In" : t === "AI" ? "Analog In" : "Digital Out";
    const symbol = resolveIoSymbol(block, t as "DI" | "DO" | "AI");
    const hasSymbol =
      block.params?.symbol !== undefined && String(block.params.symbol).trim() !== "";

    if (!hasSymbol && channel === undefined) {
      diagnostics.push(
        diag(
          "NP-0214",
          `${label} block "${block.id}" has no I/O channel assigned. Select a module and channel in the block properties.`,
          block.id
        )
      );
      continue;
    }

    const symbolMap = t === "DI" ? diSymbols : t === "AI" ? aiSymbols : doSymbols;

    const prevSym = symbolMap.get(symbol);
    if (prevSym) {
      diagnostics.push(
        diag(
          "NP-0213",
          `Duplicate ${t} symbol "${symbol}" on blocks "${prevSym}" and "${block.id}".`,
          block.id
        )
      );
    } else {
      symbolMap.set(symbol, block.id);
    }
  }

  return diagnostics;
}

function collectVariables(
  blocks: FbdBlock[],
  outputTypes: Map<string, PlcPrimitiveType>,
  ioMap: IoMap | undefined,
  programId: string,
  localVars: FbdVariable[],
  calleeVars?: Map<string, FbdVariable[]>
): { variables: IrVariable[]; io_image: PlcIr["io_image"] } {
  const variables: IrVariable[] = [];
  const di: PlcIr["io_image"]["di"] = [];
  const doList: PlcIr["io_image"]["do"] = [];
  const ai: PlcIr["io_image"]["ai"] = [];
  const ioBySymbol = new Map(ioMap?.entries.map((e) => [e.symbol, e]) ?? []);

  let diAuto = 0;
  let doAuto = 0;
  let aiAuto = 0;

  for (const v of localVars) {
    variables.push({
      name: pouIrName(programId, v.name),
      type: v.type,
      role: "internal",
      initial: v.initial ?? defaultPouInitial(v.type),
    });
  }

  for (const block of blocks) {
    const t = block.type.toUpperCase();
    if (t === "DI" || t === "DO" || t === "AI") {
      if (t === "DI") {
        const resolved = resolveIoIndex(block, "DI", ioBySymbol, diAuto);
        diAuto = resolved.nextAuto;
        di.push({ symbol: resolved.symbol, index: resolved.index });
        variables.push({ name: resolved.symbol, type: "BOOL", role: "di" });
      } else if (t === "AI") {
        const resolved = resolveIoIndex(block, "AI", ioBySymbol, aiAuto);
        aiAuto = resolved.nextAuto;
        ai.push({ symbol: resolved.symbol, index: resolved.index });
        variables.push({ name: resolved.symbol, type: "REAL", role: "ai" });
      } else {
        const resolved = resolveIoIndex(block, "DO", ioBySymbol, doAuto);
        doAuto = resolved.nextAuto;
        doList.push({ symbol: resolved.symbol, index: resolved.index });
        variables.push({ name: resolved.symbol, type: "BOOL", role: "do" });
      }
    } else if (t === "CALL") {
      const pid = String(block.params?.program ?? "").trim();
      for (const v of pouInterfaceOutputs(calleeVars?.get(pid))) {
        variables.push({
          name: callPortIrName(block.id, v.name),
          type: v.type,
          role: "internal",
        });
      }
    } else if (t === "LOCAL") {
      continue;
    } else if (t === "CONST") {
      variables.push({
        name: fbdOutputVar(block.id),
        type: parseConstDataType(block.params),
        role: "internal",
      });
    } else {
      variables.push({
        name: fbdOutputVar(block.id),
        type: outputTypes.get(block.id) ?? "BOOL",
        role: "internal",
      });
    }
  }

  return { variables, io_image: { di, do: doList, ai } };
}

function emitScheduleStep(
  block: FbdBlock,
  wireIns: Map<string, string>,
  io_image: PlcIr["io_image"],
  stepIndex: number,
  outputTypes: Map<string, PlcPrimitiveType>,
  programId: string,
  calleeVars?: Map<string, FbdVariable[]>
): ScheduleStep[] {
  const t = block.type.toUpperCase();
  const out = fbdOutputVar(block.id);
  const valueType = outputTypes.get(block.id);

  const numericStep = (
    op: ScheduleStep["op"],
    in1Key: string,
    in2Key?: string
  ): ScheduleStep[] => [
    {
      step: stepIndex,
      op,
      in1: wireIns.get(in1Key) ?? "",
      in2: in2Key ? wireIns.get(in2Key) ?? "" : undefined,
      out,
      value_type: valueType,
    },
  ];

  switch (t) {
    case "DI": {
      const symbol = resolveIoSymbol(block, "DI");
      const entry = io_image.di.find((d) => d.symbol === symbol);
      return [
        {
          step: stepIndex,
          op: "read_di",
          symbol,
          index: entry?.index ?? 0,
          out: symbol,
        },
      ];
    }
    case "AI": {
      const symbol = resolveIoSymbol(block, "AI");
      const entry = io_image.ai.find((d) => d.symbol === symbol);
      return [
        {
          step: stepIndex,
          op: "read_ai",
          symbol,
          index: entry?.index ?? 0,
          out: symbol,
        },
      ];
    }
    case "DO": {
      const symbol = resolveIoSymbol(block, "DO");
      const entry = io_image.do.find((d) => d.symbol === symbol);
      const inVar = wireIns.get("IN") ?? wireIns.get("in") ?? "";
      return [
        {
          step: stepIndex,
          op: "write_do",
          symbol,
          index: entry?.index ?? 0,
          in1: inVar,
        },
      ];
    }
    case "AND":
      return [
        {
          step: stepIndex,
          op: "and",
          in1: wireIns.get("IN1") ?? "",
          in2: wireIns.get("IN2") ?? "",
          out,
        },
      ];
    case "OR":
      return [
        {
          step: stepIndex,
          op: "or",
          in1: wireIns.get("IN1") ?? "",
          in2: wireIns.get("IN2") ?? "",
          out,
        },
      ];
    case "NOT":
      return [
        {
          step: stepIndex,
          op: "not",
          in1: wireIns.get("IN") ?? "",
          out,
        },
      ];
    case "RS":
      return [
        {
          step: stepIndex,
          op: "rs",
          block_id: block.id,
          in1: wireIns.get("SET") ?? "",
          in2: wireIns.get("RESET1") ?? "",
          out,
        },
      ];
    case "TON":
    case "TOF":
    case "TP":
      return [
        {
          step: stepIndex,
          op: t.toLowerCase() as "ton" | "tof" | "tp",
          block_id: block.id,
          in1: wireIns.get("IN") ?? "",
          out,
          pt_ms: timerPtMs(block),
        },
      ];
    case "CONST": {
      const dataType = parseConstDataType(block.params);
      const parsed = parseConstValue(block.params, dataType);
      return [
        {
          step: stepIndex,
          op: "const",
          out,
          value: parsed.ok ? parsed.value : defaultConstValue(dataType),
          value_type: dataType,
        },
      ];
    }
    case "ADD":
      return numericStep("add", "IN1", "IN2");
    case "SUB":
      return numericStep("sub", "IN1", "IN2");
    case "MUL":
      return numericStep("mul", "IN1", "IN2");
    case "DIV":
      return numericStep("div", "IN1", "IN2");
    case "POW":
      return numericStep("pow", "IN1", "IN2");
    case "SQRT":
      return numericStep("sqrt", "IN");
    case "SETBIT":
      return numericStep("setbit", "IN", "BIT");
    case "RESETBIT":
      return numericStep("resetbit", "IN", "BIT");
    case "SHL":
      return numericStep("shl", "IN", "N");
    case "SHR":
      return numericStep("shr", "IN", "N");
    case "ROL":
      return numericStep("rol", "IN", "N");
    case "ROR":
      return numericStep("ror", "IN", "N");
    case "CALL": {
      const target = String(block.params?.program ?? "").trim();
      const callee = calleeVars?.get(target) ?? [];
      const call_in: Record<string, string> = {};
      const call_out: Record<string, string> = {};
      for (const v of pouInterfaceInputs(callee)) {
        const src = wireIns.get(v.name.toUpperCase());
        if (src) {
          call_in[v.name] = src;
        }
      }
      for (const v of pouInterfaceOutputs(callee)) {
        call_out[v.name] = callPortIrName(block.id, v.name);
      }
      return [
        {
          step: stepIndex,
          op: "call",
          program: target,
          block_id: block.id,
          call_in: Object.keys(call_in).length > 0 ? call_in : undefined,
          call_out: Object.keys(call_out).length > 0 ? call_out : undefined,
        },
      ];
    }
    case "FB": {
      const target = String(block.params?.fb ?? "").trim();
      const callee = calleeVars?.get(target) ?? [];
      const call_in: Record<string, string> = {};
      const call_out: Record<string, string> = {};
      for (const v of pouInterfaceInputs(callee)) {
        const src = wireIns.get(v.name.toUpperCase());
        if (src) {
          call_in[v.name] = src;
        }
      }
      for (const v of pouInterfaceOutputs(callee)) {
        call_out[v.name] = callPortIrName(block.id, v.name);
      }
      return [
        {
          step: stepIndex,
          op: "fb",
          program: target,
          block_id: block.id,
          call_in: Object.keys(call_in).length > 0 ? call_in : undefined,
          call_out: Object.keys(call_out).length > 0 ? call_out : undefined,
        },
      ];
    }
    case "LOCAL": {
      const name = String(block.params?.name ?? "").trim();
      const src = wireIns.get("IN");
      if (!src || !name) {
        return [];
      }
      return [
        {
          step: stepIndex,
          op: "move",
          in1: src,
          out: pouIrName(programId, name),
        },
      ];
    }
    default:
      return [];
  }
}

function wireValue(
  blocks: Map<string, FbdBlock>,
  blockId: string,
  port: string,
  programId: string
): string {
  const block = blocks.get(blockId);
  if (!block) {
    return "";
  }
  return fbdSourcePortIrName(block, port, programId);
}

export function compileFbdToIr(
  project: NanoPlcProject,
  fbdRaw: unknown,
  programId: string,
  ioMap?: IoMap,
  programVars?: Map<string, FbdVariable[]>
): CompileResult {
  const { fbd, diagnostics: fbdValDiags } = validateFbdSource(fbdRaw);
  const diagnostics = [...fbdValDiags];
  if (!fbd) {
    return { ok: false, diagnostics };
  }

  const parsedVars = parsePouVariables(fbd.variables);
  const localVars = parsedVars.variables;
  const portCtx: FbdPortContext = { localVars, calleeVars: programVars };

  const blocks = blockById(fbd.blocks);
  const blockIds = fbd.blocks.map((b) => b.id);

  const dupIds = new Set<string>();
  const seen = new Set<string>();
  for (const id of blockIds) {
    if (seen.has(id)) {
      dupIds.add(id);
    }
    seen.add(id);
  }
  if (dupIds.size > 0) {
    diagnostics.push(diag("NP-0210", `Duplicate block ids: ${[...dupIds].join(", ")}.`));
  }

  for (const block of fbd.blocks) {
    if (!SUPPORTED_BLOCKS.has(block.type.toUpperCase())) {
      diagnostics.push(
        diag("NP-0211", `Unsupported block type "${block.type}".`, block.id)
      );
    }
  }

  diagnostics.push(...validateCallBlocks(fbd.blocks, project, programId));
  diagnostics.push(...validateFbBlocks(fbd.blocks, project));
  diagnostics.push(...validateLocalBlocks(fbd.blocks, localVars));
  diagnostics.push(...validateIoBindings(fbd.blocks));
  diagnostics.push(...validateConstBlocks(fbd.blocks));
  diagnostics.push(...validateTimerBlocks(fbd.blocks));

  const outputTypes = buildBlockOutputTypes(blocks, fbd.wires, portCtx);
  diagnostics.push(...validateWires(blocks, fbd.wires, outputTypes, portCtx));

  const edges = new Map<string, Set<string>>();
  for (const id of blockIds) {
    edges.set(id, new Set());
  }
  for (const wire of fbd.wires) {
    if (wire.from.block === wire.to.block) {
      diagnostics.push(diag("NP-0304", "Self-loop wire is not allowed.", wire.from.block));
      continue;
    }
    edges.get(wire.from.block)?.add(wire.to.block);
  }

  const { order, cycle } = topoSort(blockIds, edges);
  if (cycle) {
    diagnostics.push(
      diag(
        "NP-0400",
        `Combinational cycle detected among blocks: ${cycle.join(", ")}. Break the loop or insert timer/latch semantics.`
      )
    );
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const program = project.programs.find((p) => p.id === programId);
  const { variables, io_image } = collectVariables(
    fbd.blocks,
    outputTypes,
    ioMap,
    programId,
    localVars,
    programVars
  );

  const wireInsByBlock = new Map<string, Map<string, string>>();
  for (const wire of fbd.wires) {
    if (!wireInsByBlock.has(wire.to.block)) {
      wireInsByBlock.set(wire.to.block, new Map());
    }
    const portKey = wire.to.port.toUpperCase();
    wireInsByBlock
      .get(wire.to.block)!
      .set(portKey, wireValue(blocks, wire.from.block, wire.from.port, programId));
  }

  const schedule: ScheduleStep[] = [];
  let stepNum = 0;
  for (const v of localVars) {
    if (v.class !== "TEMP") {
      continue;
    }
    schedule.push({
      step: stepNum++,
      op: "const",
      out: pouIrName(programId, v.name),
      value: v.initial ?? defaultPouInitial(v.type),
      value_type: v.type,
    });
  }
  for (const blockId of order ?? []) {
    const block = blocks.get(blockId)!;
    const ins = wireInsByBlock.get(blockId) ?? new Map();
    const steps = emitScheduleStep(
      block,
      ins,
      io_image,
      stepNum,
      outputTypes,
      programId,
      programVars
    );
    for (const s of steps) {
      schedule.push({ ...s, step: stepNum++ });
    }
  }

  const instances = fbd.blocks
    .filter((b) => {
      const t = b.type.toUpperCase();
      return TIMER_BLOCKS.has(t) || t === "RS";
    })
    .map((b) => {
      const t = b.type.toUpperCase();
      if (TIMER_BLOCKS.has(t)) {
        return { id: b.id, type: t, params: { pt_ms: timerPtMs(b) } };
      }
      return { id: b.id, type: "RS", params: {} };
    });

  const ir: PlcIr = {
    ir_version: IR_VERSION,
    project: {
      name: project.name,
      board: project.device.board,
      scan_period_ms: projectScanPeriodMs(project),
      program: program?.name ?? fbd.name,
    },
    variables,
    io_image,
    network: { blocks: fbd.blocks, wires: fbd.wires },
    instances,
    schedule,
  };

  return { ok: true, ir, diagnostics };
}

function validateCallBlocks(
  blocks: FbdBlock[],
  project: NanoPlcProject,
  programId: string
): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const block of blocks) {
    if (block.type.toUpperCase() !== "CALL") {
      continue;
    }
    const target = String(block.params?.program ?? "").trim();
    if (!target) {
      diagnostics.push(
        diag("NP-0412", `CALL block "${block.id}" has no program assigned.`, block.id)
      );
      continue;
    }
    if (target === programId) {
      diagnostics.push(
        diag("NP-0410", `Program cannot call itself ("${target}").`, block.id)
      );
      continue;
    }
    const prog = project.programs.find((p) => p.id === target);
    if (!prog) {
      diagnostics.push(
        diag("NP-0413", `CALL block "${block.id}" references unknown program "${target}".`, block.id)
      );
      continue;
    }
    if (prog.language === "lad") {
      diagnostics.push(
        diag(
          "NP-0205",
          `CALL supports FBD and ST programs only ("${prog.name}" is LAD).`,
          block.id
        )
      );
    }
  }
  return diagnostics;
}

function validateFbBlocks(blocks: FbdBlock[], project: NanoPlcProject): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    if (block.type.toUpperCase() !== "FB") {
      continue;
    }
    const target = String(block.params?.fb ?? "").trim();
    if (!target) {
      diagnostics.push(diag("NP-0420", `FB block "${block.id}" has no function block assigned.`, block.id));
      continue;
    }
    if (seen.has(block.id)) {
      diagnostics.push(diag("NP-0422", `Duplicate function-block instance "${block.id}".`, block.id));
    }
    seen.add(block.id);
    const fb = project.function_blocks?.find((item) => item.id === target);
    if (!fb) {
      diagnostics.push(
        diag("NP-0421", `FB block "${block.id}" references unknown function block "${target}".`, block.id)
      );
      continue;
    }
    if (fb.language !== "fbd") {
      diagnostics.push(
        diag("NP-0205", `Function block "${fb.name}" must be FBD (found ${fb.language}).`, block.id)
      );
    }
  }
  return diagnostics;
}

function validateLocalBlocks(blocks: FbdBlock[], localVars: FbdVariable[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  for (const block of blocks) {
    if (block.type.toUpperCase() !== "LOCAL") {
      continue;
    }
    const name = String(block.params?.name ?? "").trim();
    if (!name) {
      diagnostics.push(
        diag("NP-0219", `Variable block "${block.id}" has no variable assigned.`, block.id)
      );
      continue;
    }
    if (!findPouVariable(localVars, name)) {
      diagnostics.push(
        diag("NP-0219", `Variable block "${block.id}" references unknown variable "${name}".`, block.id)
      );
    }
  }
  return diagnostics;
}

function prefixInternalName(programId: string, name: string | undefined): string | undefined {
  if (!name) {
    return name;
  }
  if (name.startsWith("__")) {
    return `__${programId}_${name.slice(2)}`;
  }
  return name;
}

function prefixMap(
  programId: string,
  map: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!map) {
    return map;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = prefixInternalName(programId, value) ?? value;
  }
  return out;
}

function prefixSchedule(programId: string, steps: ScheduleStep[]): ScheduleStep[] {
  return steps.map((step) => ({
    ...step,
    out: prefixInternalName(programId, step.out),
    in1: prefixInternalName(programId, step.in1),
    in2: prefixInternalName(programId, step.in2),
    block_id: step.block_id ? `${programId}__${step.block_id}` : step.block_id,
    call_in: prefixMap(programId, step.call_in),
    call_out: prefixMap(programId, step.call_out),
  }));
}

function mergeIoImage(parts: PlcIr["io_image"][]): PlcIr["io_image"] {
  const di = new Map<string, { symbol: string; index: number }>();
  const doList = new Map<string, { symbol: string; index: number }>();
  const ai = new Map<string, { symbol: string; index: number }>();
  for (const part of parts) {
    for (const row of part.di) {
      di.set(row.symbol, row);
    }
    for (const row of part.do) {
      doList.set(row.symbol, row);
    }
    for (const row of part.ai) {
      ai.set(row.symbol, row);
    }
  }
  return {
    di: [...di.values()],
    do: [...doList.values()],
    ai: [...ai.values()],
  };
}

function detectCallCycle(edges: Map<string, string[]>): string[] | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const dfs = (id: string): string[] | undefined => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) {
      return undefined;
    }
    visiting.add(id);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const cycle = dfs(next);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const id of edges.keys()) {
    const cycle = dfs(id);
    if (cycle) {
      return cycle;
    }
  }
  return undefined;
}

function callTargets(result: CompileResult | undefined): string[] {
  return (result?.ir?.schedule ?? [])
    .filter((s) => s.op === "call" && s.program)
    .map((s) => s.program as string);
}

/** Compile `entries` and every FBD PROGRAM they call (transitively), then check call cycles. */
function compileClosure(
  project: NanoPlcProject,
  sources: Map<string, unknown>,
  entries: string[],
  ioMap?: IoMap
): { compiled: Map<string, CompileResult>; diagnostics: CompileDiagnostic[] } {
  const compiled = new Map<string, CompileResult>();
  const diagnostics: CompileDiagnostic[] = [];
  const programVars = new Map<string, FbdVariable[]>();
  for (const [id, raw] of sources) {
    const prog = project.programs.find((item) => item.id === id);
    if (prog?.language === "st" && typeof raw === "string") {
      programVars.set(id, stProgramInterface(raw));
      continue;
    }
    const varsRaw =
      raw && typeof raw === "object" ? (raw as { variables?: unknown }).variables : undefined;
    programVars.set(id, parsePouVariables(varsRaw).variables);
  }
  const queue = [...entries];
  const enqueued = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (enqueued.has(id)) {
      continue;
    }
    enqueued.add(id);

    const prog = project.programs.find((p) => p.id === id);
    if (!prog) {
      diagnostics.push(diag("NP-0413", `Unknown program "${id}".`));
      continue;
    }
    if (prog.language === "lad") {
      diagnostics.push(diag("NP-0205", `LAD is not compiled ("${prog.name}").`));
      continue;
    }
    if (prog.language !== "fbd" && prog.language !== "st") {
      diagnostics.push(
        diag("NP-0205", `Compile supports FBD and ST only (${prog.language} not yet implemented).`)
      );
      continue;
    }
    const raw = sources.get(id);
    if (raw === undefined) {
      diagnostics.push(diag("NP-0200", `Cannot read source for program "${prog.name}".`));
      continue;
    }
    if (prog.language === "st" && typeof raw !== "string") {
      diagnostics.push(diag("NP-0200", `ST source for program "${prog.name}" is not text.`));
      continue;
    }

    const result =
      prog.language === "st"
        ? compileStToIr(project, raw as string, id, ioMap, programVars)
        : compileFbdToIr(project, raw, id, ioMap, programVars);
    compiled.set(id, result);
    for (const d of result.diagnostics) {
      diagnostics.push({ ...d, program_id: id });
    }
    queue.push(...callTargets(result));
  }

  const edges = new Map<string, string[]>();
  for (const [id, result] of compiled) {
    edges.set(id, callTargets(result));
  }
  const cycle = detectCallCycle(edges);
  if (cycle) {
    diagnostics.push(diag("NP-0411", `Program call cycle: ${cycle.join(" → ")}.`));
  }
  return { compiled, diagnostics };
}

interface AssembledIr {
  ir: PlcIr;
  /** Prefixed schedule of each compiled program. */
  schedules: Map<string, ScheduleStep[]>;
}

/** Merge compiled programs into one IR whose `schedule` is `entryProgramId`'s. */
function assembleIr(
  project: NanoPlcProject,
  compiled: Map<string, CompileResult>,
  entryProgramId: string,
  pouIds: Set<string>
): AssembledIr {
  const needsPrefix = compiled.size > 1;
  const schedules = new Map<string, ScheduleStep[]>();
  const pou_schedules: { id: string; schedule: ScheduleStep[] }[] = [];
  const variables: IrVariable[] = [];
  const ioParts: PlcIr["io_image"][] = [];
  const instances: PlcIr["instances"] = [];

  for (const [id, result] of compiled) {
    const ir = result.ir!;
    ioParts.push(ir.io_image);
    const prefixedVars = needsPrefix
      ? ir.variables.map((v) =>
          v.role === "internal" ? { ...v, name: prefixInternalName(id, v.name) ?? v.name } : v
        )
      : ir.variables;
    for (const v of prefixedVars) {
      if (!variables.some((x) => x.name === v.name)) {
        variables.push(v);
      }
    }
    for (const inst of ir.instances) {
      instances.push({
        ...inst,
        id: needsPrefix ? `${id}__${inst.id}` : inst.id,
      });
    }
    const schedule = needsPrefix ? prefixSchedule(id, ir.schedule) : ir.schedule;
    schedules.set(id, schedule);
    if (pouIds.has(id)) {
      pou_schedules.push({ id, schedule });
    }
  }

  const entryIr = compiled.get(entryProgramId)!.ir!;
  const program = project.programs.find((p) => p.id === entryProgramId);

  return {
    schedules,
    ir: {
      ir_version: IR_VERSION,
      project: {
        name: project.name,
        board: project.device.board,
        scan_period_ms: projectScanPeriodMs(project),
        program: program?.name ?? entryIr.project.program,
      },
      variables,
      io_image: mergeIoImage(ioParts),
      network: entryIr.network,
      instances,
      schedule: schedules.get(entryProgramId) ?? [],
      pou_schedules: pou_schedules.length > 0 ? pou_schedules : undefined,
    },
  };
}

/**
 * Compile the entry PROGRAM and every FBD or ST PROGRAM it calls (transitively).
 * `sources` maps program id → FBD JSON, or ST source text.
 */
export function compileProjectToIr(
  project: NanoPlcProject,
  sources: Map<string, unknown>,
  entryProgramId: string,
  ioMap?: IoMap
): CompileResult {
  const { compiled, diagnostics } = compileClosure(project, sources, [entryProgramId], ioMap);
  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }
  if (!compiled.get(entryProgramId)?.ir) {
    return { ok: false, diagnostics: [...diagnostics, diag("NP-0105", "Entry program failed to compile.")] };
  }
  const callees = new Set([...compiled.keys()].filter((id) => id !== entryProgramId));
  const assembled = assembleIr(project, compiled, entryProgramId, callees);
  const linked = linkFunctionBlocks(project, sources, assembled.ir);
  const all = [...diagnostics, ...linked];
  if (all.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics: all };
  }
  return { ok: true, diagnostics: all, ir: assembled.ir };
}

function reachablePrograms(entry: string, compiled: Map<string, CompileResult>): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    stack.push(...callTargets(compiled.get(id)));
  }
  return seen;
}

/**
 * Compile the whole Task Configuration (T1): every task's entry PROGRAM plus their CALLs.
 * `ir.schedule` is the primary cyclic task's schedule; `ir.tasks` lists every task.
 */
export function compileTasksToIr(
  project: NanoPlcProject,
  sources: Map<string, unknown>,
  ioMap?: IoMap
): CompileResult {
  const allTasks = resolveTaskConfiguration(project);
  const primary = primaryCyclicTask(allTasks);
  const tasks = allTasks
    .map((task) => ({ task, program: taskEntryProgramId(task) }))
    .filter((t): t is { task: NanoPlcTaskRef; program: string } => Boolean(t.program));
  const primaryEntry = tasks.find((t) => t.task === primary) ?? tasks[0];
  if (!primaryEntry) {
    return { ok: false, diagnostics: [diag("NP-0105", "No task has an entry program.")] };
  }

  const entries = [...new Set(tasks.map((t) => t.program))];
  const { compiled, diagnostics } = compileClosure(project, sources, entries, ioMap);
  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const called = new Set([...compiled.values()].flatMap((r) => callTargets(r)));
  const { ir, schedules } = assembleIr(project, compiled, primaryEntry.program, called);

  const tasksByProgram = new Map<string, string[]>();
  for (const { task, program } of tasks) {
    for (const id of reachablePrograms(program, compiled)) {
      tasksByProgram.set(id, [...(tasksByProgram.get(id) ?? []), task.name]);
    }
  }
  for (const [id, names] of tasksByProgram) {
    if (names.length > 1) {
      const name = project.programs.find((p) => p.id === id)?.name ?? id;
      diagnostics.push({
        code: "NP-0117",
        message: `Program "${name}" runs in tasks ${names.join(", ")}. Its variables, timers, and latches are shared between them without locking.`,
        severity: "warning",
        program_id: id,
      });
    }
  }
  const eventSources = new Map<NanoPlcTaskRef, IrEventSource>();
  for (const { task } of tasks) {
    if (task.kind !== "event") {
      continue;
    }
    const name = task.event?.trim() ?? "";
    if (!name) {
      diagnostics.push({
        code: "NP-0118",
        message: `Event task "${task.name}" has no event variable, so it never runs.`,
        severity: "warning",
      });
      continue;
    }
    const resolved = resolveEventSource(name, ir, project, ioMap);
    if (typeof resolved === "string") {
      diagnostics.push({ code: "NP-0119", message: `Event task "${task.name}": ${resolved}`, severity: "error" });
    } else {
      eventSources.set(task, resolved);
    }
  }
  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }

  ir.tasks = tasks.map(({ task, program }) => ({
    id: task.id,
    name: task.name,
    kind: task.kind,
    priority: task.priority,
    interval_ms: task.kind === "cyclic" ? task.interval_ms : undefined,
    event: task.kind === "event" ? task.event : undefined,
    event_source: eventSources.get(task),
    watchdog_ms: task.watchdog?.enabled ? task.watchdog.time_ms : undefined,
    watchdog_action:
      task.watchdog?.enabled && task.watchdog.on_timeout === "outputs_off" ? "outputs_off" : undefined,
    program,
    primary: task === primaryEntry.task ? true : undefined,
    schedule: schedules.get(program) ?? [],
  }));
  const linked = linkFunctionBlocks(project, sources, ir);
  diagnostics.push(...linked);
  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }
  return { ok: true, diagnostics, ir };
}

/**
 * Resolve an event task trigger: a DI symbol (also one no program reads, which is then
 * added to the process image), a BOOL IR variable, or `Program.Var`. Returns an error text.
 */
function resolveEventSource(
  name: string,
  ir: PlcIr,
  project: NanoPlcProject,
  ioMap?: IoMap
): IrEventSource | string {
  const di = ir.io_image.di.find((d) => d.symbol === name);
  if (di) {
    return { kind: "di", index: di.index };
  }
  let varName = name;
  const dot = name.indexOf(".");
  if (dot > 0) {
    const progKey = name.slice(0, dot);
    const prog = project.programs.find((p) => p.id === progKey || p.name === progKey);
    if (!prog) {
      return `unknown program "${progKey}" in "${name}".`;
    }
    varName = pouIrName(prog.id, name.slice(dot + 1));
  }
  const v = ir.variables.find((x) => x.name === varName);
  if (v) {
    return v.type === "BOOL" ? { kind: "var", name: v.name } : `"${name}" is ${v.type}, not BOOL.`;
  }
  const mapped = ioMap?.entries.find((e) => e.kind === "DI" && e.symbol === name);
  if (mapped) {
    ir.io_image.di.push({ symbol: mapped.symbol, index: mapped.index });
    return { kind: "di", index: mapped.index };
  }
  return `event variable "${name}" is not a DI symbol, a BOOL program variable, or Program.Var.`;
}

function mapFbName(name: string | undefined, fbId: string, instance: string): string | undefined {
  if (!name) {
    return name;
  }
  if (name.startsWith("__")) {
    return `__${instance}_${name.slice(2)}`;
  }
  const prefix = `${fbId}__`;
  if (name.startsWith(prefix)) {
    return `${instance}__${name.slice(prefix.length)}`;
  }
  return name;
}

function rewriteFbStep(step: ScheduleStep, fbId: string, instance: string): ScheduleStep {
  const mapRec = (map: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!map) {
      return map;
    }
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(map)) {
      out[key] = mapFbName(value, fbId, instance) ?? value;
    }
    return out;
  };
  return {
    ...step,
    out: mapFbName(step.out, fbId, instance),
    in1: mapFbName(step.in1, fbId, instance),
    in2: mapFbName(step.in2, fbId, instance),
    block_id: step.block_id ? `${instance}__${step.block_id}` : step.block_id,
    call_in: mapRec(step.call_in),
    call_out: mapRec(step.call_out),
  };
}

/** Expand each canvas FB into its own schedule so timers and VARs are not shared. */
function linkFunctionBlocks(
  project: NanoPlcProject,
  sources: Map<string, unknown>,
  ir: PlcIr
): CompileDiagnostic[] {
  const defs = project.function_blocks ?? [];
  if (defs.length === 0) {
    return [];
  }
  const diagnostics: CompileDiagnostic[] = [];
  const programVars = new Map<string, FbdVariable[]>();
  for (const [id, raw] of sources) {
    const varsRaw = raw && typeof raw === "object" ? (raw as { variables?: unknown }).variables : undefined;
    programVars.set(id, parsePouVariables(varsRaw).variables);
  }
  const compiled = new Map<string, PlcIr>();
  for (const fb of defs) {
    if (fb.language !== "fbd") {
      diagnostics.push(diag("NP-0205", `Function block "${fb.name}" must be FBD.`));
      continue;
    }
    const raw = sources.get(fb.id);
    if (raw === undefined) {
      diagnostics.push(diag("NP-0200", `Cannot read FBD source for function block "${fb.name}".`));
      continue;
    }
    const result = compileFbdToIr(project, raw, fb.id, undefined, programVars);
    for (const item of result.diagnostics) {
      diagnostics.push({ ...item, program_id: fb.id });
    }
    if (result.ir) {
      if (result.ir.schedule.some((step) => step.op === "fb")) {
        diagnostics.push(
          diag("NP-0423", `Function block "${fb.name}" cannot contain another FB instance.`)
        );
      }
      compiled.set(fb.id, result.ir);
    }
  }
  if (diagnostics.some((item) => item.severity === "error")) {
    return diagnostics;
  }

  const lists: ScheduleStep[][] = [ir.schedule];
  for (const pou of ir.pou_schedules ?? []) {
    lists.push(pou.schedule);
  }
  for (const task of ir.tasks ?? []) {
    lists.push(task.schedule);
  }
  const fbInstances: { id: string; def: string; schedule: ScheduleStep[] }[] = [];
  const seen = new Set<string>();
  for (const schedule of lists) {
    for (const step of schedule) {
      if (step.op !== "fb" || !step.program || !step.block_id) {
        continue;
      }
      const body = compiled.get(step.program);
      if (!body) {
        continue;
      }
      if (seen.has(step.block_id)) {
        diagnostics.push(diag("NP-0422", `Duplicate function-block instance "${step.block_id}".`, step.block_id));
        continue;
      }
      seen.add(step.block_id);
      fbInstances.push({
        id: step.block_id,
        def: step.program,
        schedule: body.schedule.map((item) => rewriteFbStep(item, step.program as string, step.block_id as string)),
      });
      for (const variable of body.variables) {
        const name = mapFbName(variable.name, step.program, step.block_id) ?? variable.name;
        if (!ir.variables.some((item) => item.name === name)) {
          ir.variables.push({ ...variable, name });
        }
      }
      for (const inst of body.instances) {
        const id = `${step.block_id}__${inst.id}`;
        if (!ir.instances.some((item) => item.id === id)) {
          ir.instances.push({ ...inst, id });
        }
      }
    }
  }
  ir.fb_defs = [...compiled.entries()].map(([id, body]) => ({ id, schedule: body.schedule }));
  ir.fb_instances = fbInstances.length > 0 ? fbInstances : undefined;
  return diagnostics;
}

