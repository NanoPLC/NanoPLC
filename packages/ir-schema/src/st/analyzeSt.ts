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
  kind: "program" | "function" | "function_block" | "method" | "class" | "interface" | "variable";
  line: number;
  start: number;
  end: number;
  /** `TYPE` for a variable, or the matching END keyword for a POU. */
  detail: string;
}

export interface StLocation {
  line: number;
  start: number;
  end: number;
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
  CLASS: "END_CLASS",
  INTERFACE: "END_INTERFACE",
  PROPERTY: "END_PROPERTY",
  GET: "END_GET",
  SET: "END_SET",
  UNION: "END_UNION",
  NAMESPACE: "END_NAMESPACE",
  CONFIGURATION: "END_CONFIGURATION",
  RESOURCE: "END_RESOURCE",
  ACTION: "END_ACTION",
  STEP: "END_STEP",
  INITIAL_STEP: "END_STEP",
  TRANSITION: "END_TRANSITION",
  VAR_ACCESS: "END_VAR",
  VAR_CONFIG: "END_VAR",
};

const VAR_BLOCKS = new Set([
  "VAR",
  "VAR_INPUT",
  "VAR_OUTPUT",
  "VAR_IN_OUT",
  "VAR_TEMP",
  "VAR_GLOBAL",
  "VAR_EXTERNAL",
  "VAR_ACCESS",
  "VAR_CONFIG",
]);

const POU_BLOCKS = new Set(["PROGRAM", "FUNCTION_BLOCK", "FUNCTION", "METHOD", "CLASS", "INTERFACE"]);

/** Keyword names and short hover text from kropochev/st-lsp (MIT). */
export const ST_KEYWORD_DETAILS: Record<string, string> = {
  PROGRAM: "Program organization unit",
  END_PROGRAM: "End PROGRAM",
  FUNCTION: "Function POU",
  END_FUNCTION: "End FUNCTION",
  FUNCTION_BLOCK: "Function block POU",
  END_FUNCTION_BLOCK: "End FUNCTION_BLOCK",
  CLASS: "OOP class",
  END_CLASS: "End CLASS",
  INTERFACE: "OOP interface",
  END_INTERFACE: "End INTERFACE",
  METHOD: "Class method",
  END_METHOD: "End METHOD",
  PROPERTY: "Class property",
  END_PROPERTY: "End PROPERTY",
  GET: "Property getter",
  END_GET: "End GET",
  SET: "Property setter",
  END_SET: "End SET",
  TYPE: "Type declarations",
  END_TYPE: "End TYPE",
  STRUCT: "Structure type",
  END_STRUCT: "End STRUCT",
  UNION: "Union type",
  END_UNION: "End UNION",
  NAMESPACE: "Namespace",
  END_NAMESPACE: "End NAMESPACE",
  USING: "Import namespace",
  CONFIGURATION: "Resource configuration",
  END_CONFIGURATION: "End CONFIGURATION",
  RESOURCE: "Configuration resource",
  END_RESOURCE: "End RESOURCE",
  TASK: "Cyclic task",
  ACTION: "SFC action",
  END_ACTION: "End ACTION",
  STEP: "SFC step",
  INITIAL_STEP: "SFC initial step",
  END_STEP: "End STEP",
  TRANSITION: "SFC transition",
  END_TRANSITION: "End TRANSITION",
  VAR: "Local variables",
  VAR_INPUT: "Input variables",
  VAR_OUTPUT: "Output variables",
  VAR_IN_OUT: "In-out variables",
  VAR_TEMP: "Temporary variables",
  VAR_GLOBAL: "Global variables",
  VAR_EXTERNAL: "External variables",
  VAR_ACCESS: "Access variables",
  VAR_CONFIG: "Instance configuration",
  END_VAR: "End VAR block",
  CONSTANT: "Constant qualifier",
  RETAIN: "Retain qualifier",
  NON_RETAIN: "Non-retain qualifier",
  PERSISTENT: "Persistent qualifier",
  ABSTRACT: "Abstract modifier",
  FINAL: "Final modifier",
  OVERRIDE: "Override modifier",
  PUBLIC: "Public access",
  PRIVATE: "Private access",
  PROTECTED: "Protected access",
  INTERNAL: "Internal access",
  EXTENDS: "Inherit from type",
  IMPLEMENTS: "Implement interface",
  IF: "Conditional",
  THEN: "IF/ELSIF body",
  ELSIF: "Else-if branch",
  ELSEIF: "Else-if branch (dialect)",
  ELSE: "Else branch",
  END_IF: "End IF",
  CASE: "Selection",
  OF: "CASE/ARRAY OF",
  END_CASE: "End CASE",
  FOR: "Counted loop",
  TO: "FOR range / POINTER TO",
  BY: "FOR step",
  DO: "Loop body",
  END_FOR: "End FOR",
  WHILE: "Pre-test loop",
  END_WHILE: "End WHILE",
  REPEAT: "Post-test loop",
  UNTIL: "REPEAT condition",
  END_REPEAT: "End REPEAT",
  EXIT: "Leave loop",
  CONTINUE: "Next loop iteration",
  RETURN: "Return from POU",
  ARRAY: "Array type",
  AT: "Direct address",
  POINTER: "Pointer type",
  REF_TO: "Reference type",
  ON: "RESOURCE ON",
  WITH: "PROGRAM WITH task",
  FROM: "TRANSITION FROM",
  AND: "Boolean AND",
  AND_THEN: "Short-circuit AND",
  OR: "Boolean OR",
  OR_ELSE: "Short-circuit OR",
  XOR: "Boolean XOR",
  NOT: "Boolean NOT",
  MOD: "Modulo",
  ADR: "Address of",
  THIS: "Current instance",
  SUPER: "Base class",
  TRUE: "Boolean true",
  FALSE: "Boolean false",
  __TRY: "CODESYS try",
  __CATCH: "CODESYS catch",
  __FINALLY: "CODESYS finally",
  __ENDTRY: "CODESYS end try",
};

export const ST_KEYWORDS = Object.keys(ST_KEYWORD_DETAILS);

export const ST_TYPES = [
  "BOOL",
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
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
  "TIME",
  "LTIME",
  "DATE",
  "LDATE",
  "TIME_OF_DAY",
  "TOD",
  "LTIME_OF_DAY",
  "LTOD",
  "DATE_AND_TIME",
  "DT",
  "LDATE_AND_TIME",
  "LDT",
  "CHAR",
  "WCHAR",
  "UCHAR",
  "STRING",
  "WSTRING",
  "USTRING",
  "ANY",
  "ANY_DERIVED",
  "ANY_ELEMENTARY",
  "ANY_MAGNITUDE",
  "ANY_NUM",
  "ANY_REAL",
  "ANY_INT",
  "ANY_UNSIGNED",
  "ANY_SIGNED",
  "ANY_DURATION",
  "ANY_BIT",
  "ANY_CHARS",
  "ANY_STRING",
  "ANY_CHAR",
  "ANY_DATE",
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
  if (open === "METHOD") {
    return "method";
  }
  if (open === "CLASS") {
    return "class";
  }
  if (open === "INTERFACE") {
    return "interface";
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
      detail: "Elementary or generic type",
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
    detail: ST_KEYWORD_DETAILS[label],
  }));
  const types = ST_TYPES.filter((type) => type.startsWith(prefix)).map((label) => ({
    label,
    kind: "type" as const,
    detail: "Elementary or generic type",
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

/** Hover text for a declared variable, keyword, or elementary type. */
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
  if (decl) {
    return `${decl.name} : ${decl.type}`;
  }
  const upper = word.toUpperCase();
  const detail = ST_KEYWORD_DETAILS[upper];
  if (detail) {
    return `${upper} — ${detail}`;
  }
  if (KNOWN_TYPES.has(upper)) {
    return `${upper} — Elementary or generic type`;
  }
  return undefined;
}

/** Same-file location of a variable or POU whose name is under the cursor. */
export function definitionSt(text: string, line: number, character: number): StLocation | undefined {
  const rawLine = text.split(/\r?\n/)[line] ?? "";
  const word = tokenAt(rawLine, character);
  if (!word) {
    return undefined;
  }
  const analysis = analyzeSt(text);
  const scope = scopeAt(analysis, line);
  const variable = analysis.variables.find(
    (item) => item.name.toUpperCase() === word.toUpperCase() && (item.scope === scope || item.scope === "<file>")
  );
  if (variable) {
    return { line: variable.line, start: variable.start, end: variable.end };
  }
  const pou = analysis.symbols.find(
    (item) => item.kind !== "variable" && item.name.toUpperCase() === word.toUpperCase()
  );
  if (!pou) {
    return undefined;
  }
  return { line: pou.line, start: pou.start, end: pou.end };
}

const FORMAT_WORDS = new Set<string>([...ST_KEYWORDS, ...ST_TYPES]);

function rewriteCode(code: string): string {
  let result = "";
  let i = 0;
  while (i < code.length) {
    const ch = code[i] ?? "";
    if (/[A-Za-z_]/.test(ch)) {
      let end = i + 1;
      while (end < code.length && /[A-Za-z0-9_]/.test(code[end] ?? "")) {
        end += 1;
      }
      const word = code.slice(i, end);
      const upper = word.toUpperCase();
      result += FORMAT_WORDS.has(upper) ? upper : word;
      i = end;
      continue;
    }
    if (ch === ":" && code[i + 1] === "=") {
      if (result.length > 0 && !/\s$/.test(result)) {
        result += " ";
      }
      result += ":=";
      i += 2;
      const next = code[i];
      if (next && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
        result += " ";
      }
      continue;
    }
    result += ch;
    i += 1;
  }
  return result;
}

/**
 * Uppercase IEC keywords and types outside comments and strings, and space `:=`.
 * Does not rewrite identifiers or vendor function names.
 */
export function formatSt(text: string): string {
  let out = "";
  let code = "";
  let i = 0;
  const flush = () => {
    if (!code) {
      return;
    }
    out += rewriteCode(code);
    code = "";
  };
  const copyQuoted = (quote: string) => {
    flush();
    out += quote;
    i += 1;
    while (i < text.length) {
      const ch = text[i] ?? "";
      out += ch;
      i += 1;
      if (ch === quote && text[i] === quote) {
        out += text[i] ?? "";
        i += 1;
        continue;
      }
      if (ch === quote || ch === "\n") {
        break;
      }
    }
  };
  while (i < text.length) {
    const ch = text[i] ?? "";
    const next = text[i + 1];
    if (ch === "'" || ch === '"') {
      copyQuoted(ch);
      continue;
    }
    if (ch === "(" && next === "*") {
      flush();
      const close = text.indexOf("*)", i + 2);
      const end = close < 0 ? text.length : close + 2;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && next === "/") {
      flush();
      const nl = text.indexOf("\n", i);
      const end = nl < 0 ? text.length : nl;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    code += ch;
    i += 1;
  }
  flush();
  return out.replace(/[ \t]+$/gm, "");
}
