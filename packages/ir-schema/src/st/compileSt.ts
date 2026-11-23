/**
 * Compile one Structured Text PROGRAM into the same schedule IR as FBD.
 * Assignments, BOOL/numeric expressions, IF, WHILE, REPEAT, FOR, and CALL
 * become `move` / `cmp` / `jump` steps. CASE, functions, and user types do not.
 */
import { IR_VERSION } from "../constants";
import { defaultPouInitial, findPouVariable, pouIrName } from "../pouVars";
import { projectScanPeriodMs } from "../tasks";
import { maskStComments } from "./analyzeSt";
import type {
  CmpRel,
  CompileDiagnostic,
  CompileResult,
  FbdVariable,
  IoMap,
  IrVariable,
  NanoPlcProject,
  PlcIr,
  PlcPrimitiveType,
  PlcVarClass,
  ScheduleStep,
} from "../types";

const IR_TYPES: Record<string, PlcPrimitiveType> = {
  BOOL: "BOOL",
  INT: "INT",
  DINT: "DINT",
  UINT: "UINT",
  WORD: "WORD",
  REAL: "REAL",
};

const QUALIFIERS = new Set(["CONSTANT", "RETAIN", "NON_RETAIN", "PERSISTENT"]);
const STMT_WORDS = new Set([
  "IF",
  "WHILE",
  "FOR",
  "REPEAT",
  "EXIT",
  "CONTINUE",
  "RETURN",
  "CASE",
  "END_PROGRAM",
  "END_VAR",
  "END_IF",
  "END_WHILE",
  "END_FOR",
  "END_REPEAT",
  "ELSE",
  "ELSIF",
  "ELSEIF",
]);

interface Tok {
  kind: "id" | "num" | "op" | "eof";
  text: string;
  line: number;
}

interface Decl {
  name: string;
  type: PlcPrimitiveType;
  varClass: PlcVarClass;
  initial?: boolean | number;
  address?: { kind: "DI" | "DO" | "AI"; index: number };
}

interface Label {
  at?: number;
}

interface LoopFrame {
  head: Label;
  end: Label;
}

function diag(code: string, message: string): CompileDiagnostic {
  return { code, message, severity: "error" };
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 0;
  const push = (kind: Tok["kind"], textValue: string) => {
    out.push({ kind, text: textValue, line });
  };
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\n") {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      push("op", ch);
      i += 1;
      continue;
    }
    if (ch === "%") {
      const start = i;
      i += 1;
      while (i < text.length && /[A-Za-z0-9.]/.test(text[i] ?? "")) {
        i += 1;
      }
      push("op", text.slice(start, i));
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < text.length && /[0-9]/.test(text[i] ?? "")) {
        i += 1;
      }
      if (text[i] === "." && /[0-9]/.test(text[i + 1] ?? "")) {
        i += 1;
        while (i < text.length && /[0-9]/.test(text[i] ?? "")) {
          i += 1;
        }
      }
      if ((text[i] === "e" || text[i] === "E") && /[0-9+-]/.test(text[i + 1] ?? "")) {
        i += 1;
        if (text[i] === "+" || text[i] === "-") {
          i += 1;
        }
        while (i < text.length && /[0-9]/.test(text[i] ?? "")) {
          i += 1;
        }
      }
      push("num", text.slice(start, i));
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i] ?? "")) {
        i += 1;
      }
      push("id", text.slice(start, i));
      continue;
    }
    const two = text.slice(i, i + 2);
    if (two === ":=" || two === "=>" || two === "<>" || two === "<=" || two === ">=") {
      push("op", two);
      i += 2;
      continue;
    }
    push("op", ch);
    i += 1;
  }
  push("eof", "");
  return out;
}

function parseAddress(token: string): { kind: "DI" | "DO" | "AI"; index: number } | undefined {
  const match = /^%(IX|QX|IW|I|Q)(\d+)$/i.exec(token);
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  const head = match[1].toUpperCase();
  const index = Number(match[2]);
  if (!Number.isInteger(index)) {
    return undefined;
  }
  if (head === "QX" || head === "Q") {
    return { kind: "DO", index };
  }
  if (head === "IW") {
    return { kind: "AI", index };
  }
  return { kind: "DI", index };
}

/** IN / OUT variables of an ST PROGRAM, for FBD or ST `CALL` ports. */
export function stProgramInterface(source: string): FbdVariable[] {
  return parseProgram(source).decls.map((item) => ({
    name: item.name,
    class: item.varClass,
    type: item.type,
    initial: item.initial,
  }));
}

export function compileStToIr(
  project: NanoPlcProject,
  source: string,
  programId: string,
  ioMap?: IoMap,
  programVars?: Map<string, FbdVariable[]>
): CompileResult {
  const parsed = parseProgram(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  if (parsed.diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, diagnostics: parsed.diagnostics };
  }
  const lowered = lowerProgram(project, programId, parsed.decls, parsed.tokens, ioMap, programVars);
  if (lowered.diagnostics.some((item) => item.severity === "error") || !lowered.ir) {
    return { ok: false, diagnostics: lowered.diagnostics };
  }
  return lowered;
}

interface ParsedProgram {
  decls: Decl[];
  tokens: Tok[];
  diagnostics: CompileDiagnostic[];
}

function parseProgram(source: string): ParsedProgram {
  const tokens = tokenize(maskStComments(source));
  const diagnostics: CompileDiagnostic[] = [];
  const decls: Decl[] = [];
  let pos = 0;
  const peek = () => tokens[pos] ?? tokens[tokens.length - 1]!;
  const at = (kind: Tok["kind"], text?: string) => {
    const tok = peek();
    if (tok.kind !== kind) {
      return false;
    }
    return text === undefined || tok.text.toUpperCase() === text.toUpperCase();
  };
  const advance = () => {
    const tok = peek();
    if (tok.kind !== "eof") {
      pos += 1;
    }
    return tok;
  };
  const lineOf = () => peek().line + 1;
  const fail = (code: string, message: string) => {
    diagnostics.push(diag(code, `Line ${lineOf()}: ${message}`));
  };
  const skipQualifiers = () => {
    while (at("id") && QUALIFIERS.has(peek().text.toUpperCase())) {
      advance();
    }
  };

  if (!at("id", "PROGRAM")) {
    fail("NP-0500", "Structured Text compile expects a PROGRAM.");
    return { decls, tokens, diagnostics };
  }
  advance();
  if (!at("id")) {
    fail("NP-0500", "PROGRAM needs a name.");
  } else {
    advance();
  }

  const seen = new Set<string>();
  while (!at("eof") && !at("id", "END_PROGRAM")) {
    skipQualifiers();
    if (!at("id")) {
      fail("NP-0500", `Unexpected "${peek().text || "end of file"}".`);
      advance();
      continue;
    }
    const word = peek().text.toUpperCase();
    if (!word.startsWith("VAR")) {
      break;
    }
    const varClass = varClassOf(word);
    advance();
    while (!at("eof") && !at("id", "END_VAR") && !at("id", "END_PROGRAM")) {
      skipQualifiers();
      if (at("id", "END_VAR") || at("id", "END_PROGRAM")) {
        break;
      }
      if (at("id") && STMT_WORDS.has(peek().text.toUpperCase())) {
        fail("NP-0500", `Expected END_VAR before ${peek().text}.`);
        break;
      }
      if (!at("id")) {
        fail("NP-0500", "Expected a variable name.");
        advance();
        continue;
      }
      const names: string[] = [];
      names.push(advance().text);
      while (at("op", ",")) {
        advance();
        if (!at("id")) {
          fail("NP-0500", "Expected a variable name after ','.");
          break;
        }
        names.push(advance().text);
      }
      let address: Decl["address"];
      if (at("id", "AT")) {
        advance();
        const addrTok = peek();
        if (addrTok.kind !== "op" || !addrTok.text.startsWith("%")) {
          fail("NP-0503", "AT expects a process-image address such as %IX0, %QX0, or %IW0.");
        } else if (addrTok.text.includes(".")) {
          fail("NP-0503", `${addrTok.text} uses IEC byte.bit form. Use a process-image index such as %IX0.`);
          advance();
        } else {
          address = parseAddress(addrTok.text);
          if (!address) {
            fail("NP-0503", `Unsupported address ${addrTok.text}. Use %IX0, %QX0, or %IW0.`);
          }
          advance();
        }
      }
      if (!at("op", ":")) {
        fail("NP-0500", "Expected ':' after the variable name.");
        continue;
      }
      advance();
      if (!at("id")) {
        fail("NP-0501", "Expected a type name.");
        continue;
      }
      const typeName = advance().text.toUpperCase();
      const type = IR_TYPES[typeName];
      if (!type) {
        fail("NP-0501", `Type ${typeName} is not compiled. Use BOOL, INT, DINT, UINT, WORD, or REAL.`);
      }
      let initial: boolean | number | undefined;
      if (at("op", ":=")) {
        advance();
        initial = parseInitial(type ?? "DINT", peek(), fail);
        if (peek().kind !== "eof" && (peek().kind !== "op" || peek().text !== ";")) {
          advance();
        }
      }
      if (at("op", ";")) {
        advance();
      } else {
        fail("NP-0500", "Expected ';' after the declaration.");
      }
      if (!type) {
        continue;
      }
      if (address && names.length > 1) {
        fail("NP-0503", "AT applies to one variable.");
      }
      for (const name of names) {
        const key = name.toUpperCase();
        if (seen.has(key) || key === "TRUE" || key === "FALSE") {
          fail("NP-0217", `Duplicate variable ${name}.`);
          continue;
        }
        seen.add(key);
        decls.push({
          name,
          type,
          varClass,
          initial,
          address,
        });
      }
    }
    if (at("id", "END_VAR")) {
      advance();
      if (at("op", ";")) {
        advance();
      }
    }
  }

  return { decls, tokens: tokens.slice(pos), diagnostics };
}

function varClassOf(word: string): PlcVarClass {
  if (word === "VAR_INPUT") {
    return "IN";
  }
  if (word === "VAR_OUTPUT") {
    return "OUT";
  }
  if (word === "VAR_IN_OUT") {
    return "IN_OUT";
  }
  if (word === "VAR_TEMP") {
    return "TEMP";
  }
  return "VAR";
}

function parseInitial(
  type: PlcPrimitiveType,
  tok: Tok,
  fail: (code: string, message: string) => void
): boolean | number | undefined {
  if (tok.kind === "id" && (tok.text.toUpperCase() === "TRUE" || tok.text.toUpperCase() === "FALSE")) {
    return tok.text.toUpperCase() === "TRUE";
  }
  if (tok.kind === "num") {
    const value = Number(tok.text);
    if (!Number.isFinite(value)) {
      fail("NP-0500", `Invalid literal ${tok.text}.`);
      return undefined;
    }
    return type === "BOOL" ? value !== 0 : type === "REAL" ? value : Math.trunc(value);
  }
  fail("NP-0500", "Expected TRUE, FALSE, or a number after ':='.");
  return undefined;
}

interface LowerResult {
  ok: boolean;
  ir?: PlcIr;
  diagnostics: CompileDiagnostic[];
}

function lowerProgram(
  project: NanoPlcProject,
  programId: string,
  decls: Decl[],
  tokens: Tok[],
  ioMap: IoMap | undefined,
  programVars: Map<string, FbdVariable[]> | undefined
): LowerResult {
  const diagnostics: CompileDiagnostic[] = [];
  const byName = new Map(decls.map((item) => [item.name.toUpperCase(), item]));
  for (const item of decls) {
    if (item.address) {
      continue;
    }
    const entry = ioMap?.entries.find((row) => row.symbol.toUpperCase() === item.name.toUpperCase());
    if (!entry) {
      continue;
    }
    item.address =
      entry.kind === "DO"
        ? { kind: "DO", index: entry.index }
        : entry.kind === "AI"
          ? { kind: "AI", index: entry.index }
          : { kind: "DI", index: entry.index };
  }

  const schedule: ScheduleStep[] = [];
  const temps: IrVariable[] = [];
  let tempCount = 0;
  let pos = 0;
  const loops: LoopFrame[] = [];
  const returnLabel: Label = {};
  const peek = () => tokens[pos] ?? { kind: "eof" as const, text: "", line: tokens[tokens.length - 1]?.line ?? 0 };
  const atWord = (word: string) => peek().kind === "id" && peek().text.toUpperCase() === word;
  const atOp = (op: string) => peek().kind === "op" && peek().text === op;
  const lineOf = () => peek().line + 1;
  const fail = (code: string, message: string) => {
    diagnostics.push(diag(code, `Line ${lineOf()}: ${message}`));
  };
  const advance = () => {
    const tok = peek();
    if (tok.kind !== "eof") {
      pos += 1;
    }
    return tok;
  };
  const irName = (name: string) => pouIrName(programId, name);
  const alloc = (type: PlcPrimitiveType): string => {
    const name = irName(`st${tempCount}`);
    tempCount += 1;
    temps.push({ name, type, role: "internal", initial: defaultPouInitial(type) });
    return name;
  };
  const emit = (step: Omit<ScheduleStep, "step"> & { targetLabel?: Label }): ScheduleStep => {
    const { targetLabel, ...rest } = step;
    const full: ScheduleStep = { ...rest, step: schedule.length };
    if (targetLabel) {
      full.target = -1;
      fixups.push({ step: full, label: targetLabel });
    }
    schedule.push(full);
    return full;
  };
  const fixups: { step: ScheduleStep; label: Label }[] = [];
  const place = (label: Label) => {
    label.at = schedule.length;
  };
  const literal = (type: PlcPrimitiveType, value: boolean | number): string => {
    const dest = alloc(type);
    emit({ op: "const", out: dest, value, value_type: type });
    return dest;
  };

  for (const item of decls) {
    if (item.varClass !== "TEMP") {
      continue;
    }
    emit({
      op: "const",
      out: irName(item.name),
      value: item.initial ?? defaultPouInitial(item.type),
      value_type: item.type,
    });
  }
  for (const item of decls) {
    if (item.address?.kind === "DI") {
      emit({ op: "read_di", out: irName(item.name), index: item.address.index, symbol: item.name });
    } else if (item.address?.kind === "AI") {
      emit({ op: "read_ai", out: irName(item.name), index: item.address.index, symbol: item.name });
    }
  }

  const stop = new Set(["END_PROGRAM"]);
  statements(stop);
  if (!atWord("END_PROGRAM") && peek().kind !== "eof") {
    fail("NP-0500", `Unexpected "${peek().text}".`);
  }
  place(returnLabel);
  for (const item of decls) {
    if (item.address?.kind === "DO") {
      emit({ op: "write_do", in1: irName(item.name), index: item.address.index, symbol: item.name });
    }
  }
  for (const fix of fixups) {
    if (fix.label.at === undefined) {
      fail("NP-0500", "Internal error: a jump has no target.");
    } else {
      fix.step.target = fix.label.at;
    }
  }

  if (diagnostics.some((item) => item.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const variables: IrVariable[] = [
    ...decls.map((item) => ({
      name: irName(item.name),
      type: item.type,
      role: "internal" as const,
      initial: item.varClass === "TEMP" ? undefined : (item.initial ?? defaultPouInitial(item.type)),
    })),
    ...temps,
  ];
  const di = decls
    .filter((item) => item.address?.kind === "DI")
    .map((item) => ({ symbol: item.name, index: item.address!.index }));
  const dout = decls
    .filter((item) => item.address?.kind === "DO")
    .map((item) => ({ symbol: item.name, index: item.address!.index }));
  const ai = decls
    .filter((item) => item.address?.kind === "AI")
    .map((item) => ({ symbol: item.name, index: item.address!.index }));
  const program = project.programs.find((item) => item.id === programId);
  const ir: PlcIr = {
    ir_version: IR_VERSION,
    project: {
      name: project.name,
      board: project.device.board,
      scan_period_ms: projectScanPeriodMs(project),
      program: program?.name ?? programId,
    },
    variables,
    io_image: { di, do: dout, ai },
    network: { blocks: [], wires: [] },
    instances: [],
    schedule,
  };
  return { ok: true, ir, diagnostics };

  function statements(enders: Set<string>): void {
    let guard = 0;
    while (peek().kind !== "eof" && !enders.has(peek().kind === "id" ? peek().text.toUpperCase() : "") && guard < 10000) {
      guard += 1;
      statement(enders);
    }
  }

  function optionalSemi(): void {
    if (atOp(";")) {
      advance();
    }
  }

  function statement(enders: Set<string>): void {
    if (atWord("IF")) {
      advance();
      compileIf();
      return;
    }
    if (atWord("WHILE")) {
      advance();
      compileWhile();
      return;
    }
    if (atWord("REPEAT")) {
      advance();
      compileRepeat();
      return;
    }
    if (atWord("FOR")) {
      advance();
      compileFor();
      return;
    }
    if (atWord("EXIT") || atWord("CONTINUE")) {
      const which = advance().text.toUpperCase();
      const frame = loops[loops.length - 1];
      if (!frame) {
        fail("NP-0500", `${which} is outside a loop.`);
      } else {
        emit({ op: "jump", targetLabel: which === "EXIT" ? frame.end : frame.head });
      }
      optionalSemi();
      return;
    }
    if (atWord("RETURN")) {
      advance();
      emit({ op: "jump", targetLabel: returnLabel });
      optionalSemi();
      return;
    }
    if (atWord("CASE")) {
      fail("NP-0502", "CASE is not compiled.");
      skipUntil(new Set(["END_CASE", "END_PROGRAM"]));
      if (atWord("END_CASE")) {
        advance();
        optionalSemi();
      }
      return;
    }
    if (peek().kind === "id") {
      const nameTok = advance();
      if (atOp("(")) {
        compileCall(nameTok.text);
        optionalSemi();
        return;
      }
      if (!atOp(":=")) {
        fail("NP-0500", `Expected ':=' or '(' after ${nameTok.text}.`);
        return;
      }
      advance();
      const decl = byName.get(nameTok.text.toUpperCase());
      if (!decl) {
        fail("NP-0501", `Unknown variable ${nameTok.text}.`);
      }
      const value = expression(decl?.type ?? "DINT");
      if (decl) {
        emit({ op: "move", in1: value, out: irName(decl.name), value_type: decl.type });
      }
      if (!atOp(";")) {
        fail("NP-0500", "Expected ';' after the assignment.");
      } else {
        advance();
      }
      return;
    }
    if (peek().kind === "eof" || enders.has(peek().text.toUpperCase())) {
      return;
    }
    fail("NP-0500", `Unexpected "${peek().text}".`);
    advance();
  }

  function compileIf(): void {
    const end = label();
    let next = label();
    compileGuarded(next);
    if (!atWord("THEN")) {
      fail("NP-0500", "IF expects THEN.");
    } else {
      advance();
    }
    statements(new Set(["ELSIF", "ELSEIF", "ELSE", "END_IF"]));
    while (atWord("ELSIF") || atWord("ELSEIF")) {
      advance();
      emit({ op: "jump", targetLabel: end });
      place(next);
      next = label();
      compileGuarded(next);
      if (!atWord("THEN")) {
        fail("NP-0500", "ELSIF expects THEN.");
      } else {
        advance();
      }
      statements(new Set(["ELSIF", "ELSEIF", "ELSE", "END_IF"]));
    }
    if (atWord("ELSE")) {
      advance();
      emit({ op: "jump", targetLabel: end });
      place(next);
      statements(new Set(["END_IF"]));
    } else {
      place(next);
    }
    if (!atWord("END_IF")) {
      fail("NP-0500", "IF is not closed with END_IF.");
    } else {
      advance();
      optionalSemi();
    }
    place(end);
  }

  function compileWhile(): void {
    const head = label();
    const end = label();
    place(head);
    compileGuarded(end);
    if (!atWord("DO")) {
      fail("NP-0500", "WHILE expects DO.");
    } else {
      advance();
    }
    loops.push({ head, end });
    statements(new Set(["END_WHILE"]));
    loops.pop();
    emit({ op: "jump", targetLabel: head });
    if (!atWord("END_WHILE")) {
      fail("NP-0500", "WHILE is not closed with END_WHILE.");
    } else {
      advance();
      optionalSemi();
    }
    place(end);
  }

  function compileRepeat(): void {
    const head = label();
    const until = label();
    const end = label();
    place(head);
    loops.push({ head: until, end });
    statements(new Set(["UNTIL"]));
    loops.pop();
    place(until);
    if (!atWord("UNTIL")) {
      fail("NP-0500", "REPEAT expects UNTIL.");
    } else {
      advance();
    }
    const cond = expression("BOOL");
    emit({ op: "jump_if_false", in1: cond, targetLabel: head });
    if (!atWord("END_REPEAT")) {
      fail("NP-0500", "REPEAT is not closed with END_REPEAT.");
    } else {
      advance();
      optionalSemi();
    }
    place(end);
  }

  function compileFor(): void {
    if (peek().kind !== "id") {
      fail("NP-0500", "FOR expects a variable.");
      return;
    }
    const name = advance().text;
    const decl = byName.get(name.toUpperCase());
    if (!decl) {
      fail("NP-0501", `Unknown variable ${name}.`);
    }
    if (!atOp(":=")) {
      fail("NP-0500", "FOR expects ':='.");
    } else {
      advance();
    }
    const start = expression(decl?.type ?? "DINT");
    if (decl) {
      emit({ op: "move", in1: start, out: irName(decl.name), value_type: decl.type });
    }
    if (!atWord("TO")) {
      fail("NP-0500", "FOR expects TO.");
    } else {
      advance();
    }
    const limit = expression(decl?.type ?? "DINT");
    let step = literal(decl?.type ?? "DINT", 1);
    if (atWord("BY")) {
      advance();
      step = expression(decl?.type ?? "DINT");
    }
    if (!atWord("DO")) {
      fail("NP-0500", "FOR expects DO.");
    } else {
      advance();
    }
    const head = label();
    const end = label();
    const neg = label();
    const after = label();
    place(head);
    const positive = alloc("BOOL");
    const zero = literal(decl?.type ?? "DINT", 0);
    emit({ op: "cmp", rel: "ge", in1: step, in2: zero, out: positive, value_type: "BOOL" });
    emit({ op: "jump_if_false", in1: positive, targetLabel: neg });
    const cond = alloc("BOOL");
    const index = decl ? irName(decl.name) : start;
    emit({ op: "cmp", rel: "le", in1: index, in2: limit, out: cond, value_type: "BOOL" });
    emit({ op: "jump", targetLabel: after });
    place(neg);
    emit({ op: "cmp", rel: "ge", in1: index, in2: limit, out: cond, value_type: "BOOL" });
    place(after);
    emit({ op: "jump_if_false", in1: cond, targetLabel: end });
    const stepLabel = label();
    loops.push({ head: stepLabel, end });
    statements(new Set(["END_FOR"]));
    loops.pop();
    place(stepLabel);
    if (decl) {
      const next = alloc(decl.type);
      emit({ op: "add", in1: irName(decl.name), in2: step, out: next, value_type: decl.type });
      emit({ op: "move", in1: next, out: irName(decl.name), value_type: decl.type });
    }
    emit({ op: "jump", targetLabel: head });
    if (!atWord("END_FOR")) {
      fail("NP-0500", "FOR is not closed with END_FOR.");
    } else {
      advance();
      optionalSemi();
    }
    place(end);
  }

  function compileGuarded(whenFalse: Label): void {
    const cond = expression("BOOL");
    emit({ op: "jump_if_false", in1: cond, targetLabel: whenFalse });
  }

  function compileCall(calleeText: string): void {
    const target = project.programs.find(
      (item) => item.id === calleeText || item.name.toUpperCase() === calleeText.toUpperCase()
    );
    if (!target) {
      fail("NP-0413", `Unknown program ${calleeText}.`);
    } else if (target.id === programId) {
      fail("NP-0410", `Program cannot call itself ("${target.id}").`);
    } else if (target.language === "lad") {
      fail("NP-0205", `CALL supports FBD and ST programs only ("${target.name}" is LAD).`);
    }
    if (!atOp("(")) {
      return;
    }
    advance();
    const callIn: Record<string, string> = {};
    const callOut: Record<string, string> = {};
    if (!atOp(")")) {
      for (;;) {
        if (peek().kind !== "id") {
          fail("NP-0500", "CALL argument expects a port name.");
          break;
        }
        const portTok = advance().text;
        const iface = target ? programVars?.get(target.id) : undefined;
        const port = findPouVariable(iface, portTok)?.name ?? portTok;
        if (atOp("=>")) {
          advance();
          if (peek().kind !== "id") {
            fail("NP-0500", "CALL output expects a variable.");
            break;
          }
          const dest = advance().text;
          const destDecl = byName.get(dest.toUpperCase());
          if (!destDecl) {
            fail("NP-0501", `Unknown variable ${dest}.`);
          } else {
            callOut[port] = irName(destDecl.name);
          }
        } else if (atOp(":=")) {
          advance();
          const portType = findPouVariable(iface, portTok)?.type ?? "BOOL";
          callIn[port] = expression(portType);
        } else {
          fail("NP-0500", "CALL argument expects ':=' or '=>'.");
          break;
        }
        if (atOp(",")) {
          advance();
          continue;
        }
        break;
      }
    }
    if (!atOp(")")) {
      fail("NP-0500", "CALL expects ')'.");
    } else {
      advance();
    }
    if (target && target.id !== programId && target.language !== "lad") {
      emit({
        op: "call",
        program: target.id,
        call_in: callIn,
        call_out: callOut,
      });
    }
  }

  function expression(expected: PlcPrimitiveType): string {
    return parseOr(expected);
  }

  function parseOr(expected: PlcPrimitiveType): string {
    let left = parseXor(expected);
    while (atWord("OR") || atWord("OR_ELSE")) {
      advance();
      const right = parseXor("BOOL");
      const dest = alloc("BOOL");
      emit({ op: "or", in1: left, in2: right, out: dest });
      left = dest;
    }
    return left;
  }

  function parseXor(expected: PlcPrimitiveType): string {
    let left = parseAnd(expected);
    while (atWord("XOR")) {
      advance();
      const right = parseAnd("BOOL");
      const both = alloc("BOOL");
      const either = alloc("BOOL");
      const notBoth = alloc("BOOL");
      const dest = alloc("BOOL");
      emit({ op: "and", in1: left, in2: right, out: both });
      emit({ op: "or", in1: left, in2: right, out: either });
      emit({ op: "not", in1: both, out: notBoth });
      emit({ op: "and", in1: either, in2: notBoth, out: dest });
      left = dest;
    }
    return left;
  }

  function parseAnd(expected: PlcPrimitiveType): string {
    let left = parseCmp(expected);
    while (atWord("AND") || atWord("AND_THEN")) {
      advance();
      const right = parseCmp("BOOL");
      const dest = alloc("BOOL");
      emit({ op: "and", in1: left, in2: right, out: dest });
      left = dest;
    }
    return left;
  }

  function parseCmp(expected: PlcPrimitiveType): string {
    const left = parseAdd(expected);
    const rel = cmpRel(peek());
    if (!rel) {
      return left;
    }
    advance();
    const right = parseAdd(expected === "BOOL" ? "DINT" : expected);
    const dest = alloc("BOOL");
    emit({ op: "cmp", rel, in1: left, in2: right, out: dest, value_type: "BOOL" });
    return dest;
  }

  function parseAdd(expected: PlcPrimitiveType): string {
    let left = parseMul(expected);
    while (atOp("+") || atOp("-")) {
      const op = advance().text === "+" ? "add" : "sub";
      const right = parseMul(expected);
      const type = numericType(expected);
      const dest = alloc(type);
      emit({ op, in1: left, in2: right, out: dest, value_type: type });
      left = dest;
    }
    return left;
  }

  function parseMul(expected: PlcPrimitiveType): string {
    let left = parseUnary(expected);
    while (atOp("*") || atOp("/") || atWord("MOD")) {
      const tok = advance();
      if (tok.text.toUpperCase() === "MOD") {
        fail("NP-0502", "MOD is not compiled.");
      }
      const op = tok.text === "/" ? "div" : "mul";
      const right = parseUnary(expected);
      const type = numericType(expected);
      const dest = alloc(type);
      emit({ op, in1: left, in2: right, out: dest, value_type: type });
      left = dest;
    }
    return left;
  }

  function parseUnary(expected: PlcPrimitiveType): string {
    if (atWord("NOT")) {
      advance();
      const value = parseUnary("BOOL");
      const dest = alloc("BOOL");
      emit({ op: "not", in1: value, out: dest });
      return dest;
    }
    if (atOp("-")) {
      advance();
      const value = parseUnary(numericType(expected));
      const type = numericType(expected);
      const zero = literal(type, 0);
      const dest = alloc(type);
      emit({ op: "sub", in1: zero, in2: value, out: dest, value_type: type });
      return dest;
    }
    if (atOp("+")) {
      advance();
      return parseUnary(expected);
    }
    return parsePrimary(expected);
  }

  function parsePrimary(expected: PlcPrimitiveType): string {
    if (atOp("(")) {
      advance();
      const value = expression(expected);
      if (!atOp(")")) {
        fail("NP-0500", "Expected ')'.");
      } else {
        advance();
      }
      return value;
    }
    if (atWord("TRUE") || atWord("FALSE")) {
      const value = advance().text.toUpperCase() === "TRUE";
      return literal("BOOL", value);
    }
    if (peek().kind === "num") {
      const text = advance().text;
      const value = Number(text);
      const type: PlcPrimitiveType = /[eE.]/.test(text) ? "REAL" : numericType(expected);
      return literal(type, type === "REAL" ? value : Math.trunc(value));
    }
    if (peek().kind === "id") {
      const name = advance().text;
      const decl = byName.get(name.toUpperCase());
      if (!decl) {
        fail("NP-0501", `Unknown variable ${name}.`);
        return literal(expected, defaultPouInitial(expected));
      }
      return irName(decl.name);
    }
    if (atOp("'") || atOp('"')) {
      fail("NP-0502", "String literals are not compiled.");
      advance();
      return literal(expected, defaultPouInitial(expected));
    }
    fail("NP-0500", "Expected an expression.");
    return literal(expected, defaultPouInitial(expected));
  }

  function skipUntil(words: Set<string>): void {
    let guard = 0;
    while (peek().kind !== "eof" && !words.has(peek().kind === "id" ? peek().text.toUpperCase() : "") && guard < 10000) {
      guard += 1;
      advance();
    }
  }

  function label(): Label {
    return {};
  }
}

function cmpRel(tok: Tok): CmpRel | undefined {
  switch (tok.kind === "op" ? tok.text : "") {
    case "=":
      return "eq";
    case "<>":
      return "ne";
    case "<":
      return "lt";
    case "<=":
      return "le";
    case ">":
      return "gt";
    case ">=":
      return "ge";
    default:
      return undefined;
  }
}

function numericType(expected: PlcPrimitiveType): PlcPrimitiveType {
  return expected === "BOOL" ? "DINT" : expected;
}
