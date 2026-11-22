import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeSt, completeSt, hoverSt } from "./analyzeSt";

const program = `PROGRAM Main
VAR
  Start : BOOL;
  Count : INT := 0;
END_VAR
IF Start THEN
  Count := Count + 1;
END_IF
END_PROGRAM
`;

test("structured text accepts a closed program", () => {
  const result = analyzeSt(program);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.symbols.some((symbol) => symbol.kind === "program" && symbol.name === "Main"), true);
  assert.equal(result.variables.find((item) => item.name === "Count")?.type, "INT");
});

test("structured text reports a mismatched END and an unclosed VAR", () => {
  const result = analyzeSt(`PROGRAM Main
VAR
  Start : BOOL;
END_IF
`);
  const codes = result.diagnostics.map((item) => item.code);
  assert.ok(codes.includes("ST0002"));
  assert.ok(codes.includes("ST0001"));
});

test("structured text flags a duplicate variable and a non-elementary type", () => {
  const result = analyzeSt(`PROGRAM Main
VAR
  Start : BOOL;
  Start : BOOL;
  Mode : TON;
END_VAR
END_PROGRAM
`);
  assert.ok(result.diagnostics.some((item) => item.code === "ST0004"));
  assert.ok(result.diagnostics.some((item) => item.code === "ST0005" && item.message.includes("TON")));
});

test("comments do not close a block", () => {
  const result = analyzeSt(`PROGRAM Main
(* END_PROGRAM *)
VAR
  Flag : BOOL; // : INT
END_VAR
END_PROGRAM
`);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.variables.length, 1);
});

test("completion after a colon lists elementary types", () => {
  const text = "VAR\n  Flag : BO\nEND_VAR\n";
  const items = completeSt(text, 1, "  Flag : BO".length);
  assert.ok(items.some((item) => item.label === "BOOL" && item.kind === "type"));
  assert.equal(items.some((item) => item.label === "PROGRAM"), false);
});

test("hover names a declared variable", () => {
  const use = "  Count := Count + 1;";
  const useLine = program.split("\n").findIndex((row) => row.includes("Count :="));
  assert.equal(hoverSt(program, useLine, use.indexOf("Count") + 2), "Count : INT");
});
