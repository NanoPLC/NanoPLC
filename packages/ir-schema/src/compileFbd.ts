import { IR_VERSION } from "./constants";
import type {
  CompileDiagnostic,
  CompileResult,
  FbdBlock,
  FbdSource,
  FbdVariable,
  FbdWire,
  IoMap,
  IoMapEntry,
  IrVariable,
  NanoPlcProject,
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
import { projectScanPeriodMs } from "./tasks";
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
  "LOCAL",
]);

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
    case "TON": {
      const pt = block.params?.pt_ms ?? block.params?.PT ?? 1000;
      return [
        {
          step: stepIndex,
          op: "ton",
          block_id: block.id,
          in1: wireIns.get("IN") ?? "",
          out,
          pt_ms: typeof pt === "number" ? pt : Number(pt),
        },
      ];
    }
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
  diagnostics.push(...validateLocalBlocks(fbd.blocks, localVars));
  diagnostics.push(...validateIoBindings(fbd.blocks));
  diagnostics.push(...validateConstBlocks(fbd.blocks));

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
      return t === "TON" || t === "RS";
    })
    .map((b) => {
      const t = b.type.toUpperCase();
      if (t === "TON") {
        return {
          id: b.id,
          type: "TON",
          params: { pt_ms: b.params?.pt_ms ?? b.params?.PT ?? 1000 },
        };
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
    if (prog.language !== "fbd") {
      diagnostics.push(
        diag(
          "NP-0205",
          `CALL currently supports FBD programs only ("${prog.name}" is ${prog.language}).`,
          block.id
        )
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

/**
 * Compile the entry PROGRAM and every FBD PROGRAM it calls (transitively).
 * `sources` maps program id → FBD JSON.
 */
export function compileProjectToIr(
  project: NanoPlcProject,
  sources: Map<string, unknown>,
  entryProgramId: string,
  ioMap?: IoMap
): CompileResult {
  const compiled = new Map<string, CompileResult>();
  const diagnostics: CompileDiagnostic[] = [];
  const programVars = new Map<string, FbdVariable[]>();
  for (const [id, raw] of sources) {
    const varsRaw =
      raw && typeof raw === "object" ? (raw as { variables?: unknown }).variables : undefined;
    programVars.set(id, parsePouVariables(varsRaw).variables);
  }
  const queue = [entryProgramId];
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
    if (prog.language !== "fbd") {
      diagnostics.push(
        diag("NP-0205", `Compile supports FBD JSON only (${prog.language} not yet implemented).`)
      );
      continue;
    }
    const raw = sources.get(id);
    if (raw === undefined) {
      diagnostics.push(diag("NP-0200", `Cannot read FBD source for program "${prog.name}".`));
      continue;
    }

    const result = compileFbdToIr(project, raw, id, ioMap, programVars);
    compiled.set(id, result);
    for (const d of result.diagnostics) {
      diagnostics.push({ ...d, program_id: id });
    }
    if (result.ir) {
      for (const step of result.ir.schedule) {
        if (step.op === "call" && step.program) {
          queue.push(step.program);
        }
      }
    }
  }

  const edges = new Map<string, string[]>();
  for (const [id, result] of compiled) {
    edges.set(
      id,
      (result.ir?.schedule ?? [])
        .filter((s) => s.op === "call" && s.program)
        .map((s) => s.program as string)
    );
  }
  const cycle = detectCallCycle(edges);
  if (cycle) {
    diagnostics.push(
      diag("NP-0411", `Program call cycle: ${cycle.join(" → ")}.`)
    );
  }

  if (diagnostics.some((d) => d.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const entryResult = compiled.get(entryProgramId);
  if (!entryResult?.ir) {
    return { ok: false, diagnostics: [...diagnostics, diag("NP-0105", "Entry program failed to compile.")] };
  }

  const needsPrefix = compiled.size > 1;
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
    if (id !== entryProgramId) {
      pou_schedules.push({
        id,
        schedule: needsPrefix ? prefixSchedule(id, ir.schedule) : ir.schedule,
      });
    }
  }

  const entryIr = entryResult.ir;
  const schedule = needsPrefix ? prefixSchedule(entryProgramId, entryIr.schedule) : entryIr.schedule;
  const program = project.programs.find((p) => p.id === entryProgramId);

  return {
    ok: true,
    diagnostics,
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
      schedule,
      pou_schedules: pou_schedules.length > 0 ? pou_schedules : undefined,
    },
  };
}
