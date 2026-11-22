/** Structural Structured Text helper. Not a compiler and not emitted into IR. */

export interface StDiagnostic {
  /** 0-based line. */
  line: number;
  start: number;
  end: number;
  severity: "error" | "warning";
  code: string;
  message: string;
}

export interface StSymbol {
  name: string;
  kind: "program" | "function" | "function_block" | "variable";
  line: number;
  start: number;
  end: number;
  /** `TYPE` for a variable, or the matching END keyword for a POU. */
  detail: string;
}

export interface StCompletion {
  label: string;
  kind: "keyword" | "type" | "variable";
  detail?: string;
}

const BLOCKS: Record<string, string> = {
  PROGRAM: "END_PROGRAM",
  FUNCTION_BLOCK: "END_FUNCTION_BLOCK",
  FUNCTION: "END_FUNCTION",
  METHOD: "END_METHOD",
  VAR: "END_VAR",
  VAR_INPUT: "END_VAR",
  VAR_OUTPUT: "END_VAR",
  VAR_IN_OUT: "END_VAR",
  VAR_TEMP: "END_VAR",
  VAR_GLOBAL: "END_VAR",
  VAR_EXTERNAL: "END_VAR",
  IF: "END_IF",
  CASE: "END_CASE",
  FOR: "END_FOR",
  WHILE: "END_WHILE",
  REPEAT: "END_REPEAT",
  STRUCT: "END_STRUCT",
  TYPE: "END_TYPE",
};

const VAR_BLOCKS = new Set([
  "VAR",
  "VAR_INPUT",
  "VAR_OUTPUT",
  "VAR_IN_OUT",
  "VAR_TEMP",
  "VAR_GLOBAL",
  "VAR_EXTERNAL",
]);

const POU_BLOCKS = new Set(["PROGRAM", "FUNCTION_BLOCK", "FUNCTION", "METHOD"]);

export const ST_KEYWORDS = [
  "PROGRAM",
  "END_PROGRAM",
  "FUNCTION",
  "END_FUNCTION",
  "FUNCTION_BLOCK",
  "END_FUNCTION_BLOCK",
  "METHOD",
  "END_METHOD",
  "VAR",
  "VAR_INPUT",
  "VAR_OUTPUT",
  "VAR_IN_OUT",
  "VAR_TEMP",
  "VAR_GLOBAL",
  "END_VAR",
  "IF",
  "THEN",
  "ELSIF",
  "ELSE",
  "END_IF",
  "CASE",
  "OF",
  "END_CASE",
  "FOR",
  "TO",
  "BY",
  "DO",
  "END_FOR",
  "WHILE",
  "END_WHILE",
  "REPEAT",
  "UNTIL",
  "END_REPEAT",
  "RETURN",
  "EXIT",
  "TRUE",
  "FALSE",
] as const;

export const ST_TYPES = [
  "BOOL",
  "SINT",
  "INT",
  "DINT",
  "LINT",
  "USINT",
  "UINT",
  "UDINT",
  "ULINT",
  "REAL",
  "LREAL",
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
  "TIME",
  "DATE",
  "TIME_OF_DAY",
  "TOD",
  "DATE_AND_TIME",
  "DT",
  "STRING",
  "WSTRING",
] as const;

const KNOWN_TYPES = new Set<string>(ST_TYPES);

interface Frame {
  open: string;
  end: string;
  line: number;
  start: number;
}

interface VarDecl {
  name: string;
  type: string;
  line: number;
  start: number;
  end: number;
  scope: string;
}

export interface StAnalysis {
  diagnostics: StDiagnostic[];
  symbols: StSymbol[];
  variables: VarDecl[];
}

/** Replace comments with spaces so later indexes still match the source. */
export function maskStComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  let inBlock = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inBlock) {
      if (ch === "*" && next === ")") {
        out += "  ";
        i += 2;
        inBlock = false;
      } else {
        out += ch === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (next === "'") {
          out += next;
          i += 2;
          continue;
        }
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === "(" && next === "*") {
      out += "  ";
      i += 2;
      inBlock = true;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function firstKeyword(line: string): { word: string; start: number } | undefined {
  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
  if (!match?.[1]) {
    return undefined;
  }
  return { word: match[1].toUpperCase(), start: match.index + match[0].length - match[1].length };
}

function pouKind(open: string): StSymbol["kind"] | undefined {
  if (open === "PROGRAM") {
    return "program";
  }
  if (open === "FUNCTION") {
    return "function";
  }
  if (open === "FUNCTION_BLOCK") {
    return "function_block";
  }
  return undefined;
}

export function analyzeSt(text: string): StAnalysis {
  const masked = maskStComments(text);
  const lines = masked.split(/\r?\n/);
  const diagnostics: StDiagnostic[] = [];
  const symbols: StSymbol[] = [];
  const variables: VarDecl[] = [];
  const stack: Frame[] = [];
  let scope = "";
  const seen = new Map<string, Set<string>>();

  const pushDiag = (
    line: number,
    start: number,
    end: number,
    severity: StDiagnostic["severity"],
    code: string,
    message: string
  ) => {
    diagnostics.push({ line, start, end: Math.max(end, start + 1), severity, code, message });
  };

  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo] ?? "";
    const head = firstKeyword(line);
    if (!head) {
      continue;
    }
    const expectedEnd = BLOCKS[head.word];
    if (expectedEnd && head.word !== "END_VAR") {
      const nameMatch = new RegExp(`^\\s*${head.word}\\s+([A-Za-z_][A-Za-z0-9_]*)`, "i").exec(line);
      const name = nameMatch?.[1] ?? head.word;
      const kind = pouKind(head.word);
      if (kind && nameMatch?.[1]) {
        scope = nameMatch[1];
        symbols.push({
          name: nameMatch[1],
          kind,
          line: lineNo,
          start: nameMatch.index + nameMatch[0].length - nameMatch[1].length,
          end: nameMatch.index + nameMatch[0].length,
          detail: expectedEnd,
        });
      }
      stack.push({ open: head.word, end: expectedEnd, line: lineNo, start: head.start });
      continue;
    }
    if (head.word.startsWith("END_")) {
      const frame = stack[stack.length - 1];
      if (!frame) {
        pushDiag(lineNo, head.start, head.start + head.word.length, "error", "ST0002", `Unexpected ${head.word}.`);
        continue;
      }
      if (frame.end !== head.word) {
        pushDiag(
          lineNo,
          head.start,
          head.start + head.word.length,
          "error",
          "ST0002",
          `Expected ${frame.end} to close ${frame.open}, found ${head.word}.`
        );
        continue;
      }
      stack.pop();
      if (POU_BLOCKS.has(frame.open)) {
        scope = "";
      }
      continue;
    }
    const inVar = [...stack].reverse().find((frame) => VAR_BLOCKS.has(frame.open));
    if (!inVar) {
      continue;
    }
    const decl = /^(\s*)([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(
      line
    );
    if (!decl?.[2] || !decl[3]) {
      if (/^\s*[A-Za-z_]/.test(line) && !head.word.startsWith("END_")) {
        pushDiag(lineNo, head.start, line.trimEnd().length, "warning", "ST0003", "Expected a name : TYPE declaration.");
      }
      continue;
    }
    const typeName = decl[3];
    if (!KNOWN_TYPES.has(typeName.toUpperCase())) {
      pushDiag(
        lineNo,
        line.indexOf(typeName),
        line.indexOf(typeName) + typeName.length,
        "warning",
        "ST0005",
        `Type ${typeName} is not an elementary IEC type. User types are not resolved in this editor.`
      );
    }
    const scopeKey = scope || "<file>";
    const bag = seen.get(scopeKey) ?? new Set<string>();
    seen.set(scopeKey, bag);
    const names = decl[2].split(",").map((part) => part.trim()).filter(Boolean);
    let cursor = decl[1]?.length ?? 0;
    for (const name of names) {
      const at = line.indexOf(name, cursor);
      const start = at >= 0 ? at : cursor;
      if (bag.has(name.toUpperCase())) {
        pushDiag(lineNo, start, start + name.length, "error", "ST0004", `Duplicate variable ${name}.`);
      }
      bag.add(name.toUpperCase());
      variables.push({
        name,
        type: typeName.toUpperCase(),
        line: lineNo,
        start,
        end: start + name.length,
        scope: scopeKey,
      });
      symbols.push({
        name,
        kind: "variable",
        line: lineNo,
        start,
        end: start + name.length,
        detail: typeName.toUpperCase(),
      });
      cursor = start + name.length;
    }
  }

  for (const frame of stack) {
    pushDiag(
      frame.line,
      frame.start,
      frame.start + frame.open.length,
      "error",
      "ST0001",
      `${frame.open} is not closed with ${frame.end}.`
    );
  }

  return { diagnostics, symbols, variables };
}

function tokenAt(line: string, character: number): string {
  let start = character;
  let end = character;
  while (start > 0 && /[A-Za-z0-9_]/.test(line[start - 1] ?? "")) {
    start -= 1;
  }
  while (end < line.length && /[A-Za-z0-9_]/.test(line[end] ?? "")) {
    end += 1;
  }
  const word = line.slice(start, end);
  return /^[A-Za-z_]/.test(word) ? word : "";
}

function scopeAt(analysis: StAnalysis, line: number): string {
  let scope = "<file>";
  for (const symbol of analysis.symbols) {
    if (symbol.line > line) {
      break;
    }
    if (symbol.kind !== "variable") {
      scope = symbol.name;
    }
  }
  return scope;
}

/** Completions for the identifier being typed, or types after a colon. */
export function completeSt(text: string, line: number, character: number): StCompletion[] {
  const rawLine = text.split(/\r?\n/)[line] ?? "";
  const before = rawLine.slice(0, character);
  const analysis = analyzeSt(text);
  if (/:\s*[A-Za-z_]*$/.test(before)) {
    const prefix = /[A-Za-z_]*$/.exec(before)?.[0] ?? "";
    return ST_TYPES.filter((type) => type.startsWith(prefix.toUpperCase())).map((label) => ({
      label,
      kind: "type" as const,
      detail: "elementary type",
    }));
  }
  const prefix = (/[A-Za-z_][A-Za-z0-9_]*$/.exec(before)?.[0] ?? "").toUpperCase();
  const scope = scopeAt(analysis, line);
  const variables = analysis.variables
    .filter((item) => item.scope === scope || item.scope === "<file>")
    .filter((item) => item.name.toUpperCase().startsWith(prefix))
    .map((item) => ({ label: item.name, kind: "variable" as const, detail: item.type }));
  const keywords = ST_KEYWORDS.filter((kw) => kw.startsWith(prefix)).map((label) => ({
    label,
    kind: "keyword" as const,
  }));
  const types = ST_TYPES.filter((type) => type.startsWith(prefix)).map((label) => ({
    label,
    kind: "type" as const,
    detail: "elementary type",
  }));
  const seen = new Set<string>();
  const out: StCompletion[] = [];
  for (const item of [...variables, ...keywords, ...types]) {
    if (seen.has(item.label)) {
      continue;
    }
    seen.add(item.label);
    out.push(item);
  }
  return out;
}

/** Hover text for a declared variable at this position. */
export function hoverSt(text: string, line: number, character: number): string | undefined {
  const rawLine = text.split(/\r?\n/)[line] ?? "";
  const word = tokenAt(rawLine, character);
  if (!word) {
    return undefined;
  }
  const analysis = analyzeSt(text);
  const scope = scopeAt(analysis, line);
  const decl = analysis.variables.find(
    (item) => item.name.toUpperCase() === word.toUpperCase() && (item.scope === scope || item.scope === "<file>")
  );
  if (!decl) {
    return undefined;
  }
  return `${decl.name} : ${decl.type}`;
}
