import assert from "node:assert/strict";
import { test } from "node:test";

import { codegenC } from "../codegen/cGenerator";
import { compileTasksToIr } from "../compileFbd";
import { PROJECT_SCHEMA_VERSION } from "../constants";
import { PlcSimulator } from "../simulator/PlcSimulator";
import type { NanoPlcProject } from "../types";

function project(programs: NanoPlcProject["programs"]): NanoPlcProject {
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    name: "st_main",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs,
  };
}

const main = `PROGRAM Main
VAR
  Run : BOOL := TRUE;
  Count : INT := 0;
  Lamp AT %QX0 : BOOL;
END_VAR
IF Run THEN
  Count := Count + 1; // + 100
ELSE
  Count := 0;
END_IF
WHILE Count < 3 DO
  Count := Count + 1;
END_WHILE
Lamp := Count = 4;
END_PROGRAM
`;

test("structured text compiles to a schedule the simulator runs", () => {
  const compiled = compileTasksToIr(
    project([{ id: "main", name: "Main", source: "src/main.st", language: "st" }]),
    new Map<string, unknown>([["main", main]]),
    undefined
  );
  assert.equal(compiled.ok, true, compiled.diagnostics.map((item) => item.message).join("; "));
  assert.ok(compiled.ir?.schedule.some((step) => step.op === "jump_if_false"));
  assert.ok(compiled.ir?.schedule.some((step) => step.op === "cmp"));
  assert.ok(compiled.ir?.schedule.some((step) => step.op === "write_do"));

  const sim = new PlcSimulator(compiled.ir!);
  const first = sim.stepOnce();
  assert.equal(first.vars["main__Count"], 3);
  assert.equal(first.vars["main__Lamp"], false);
  assert.equal(first.do[0], false);
  const second = sim.stepOnce();
  assert.equal(second.vars["main__Count"], 4);
  assert.equal(second.vars["main__Lamp"], true);
  assert.equal(second.do[0], true);

  const again = sim.stepOnce();
  assert.equal(again.vars["main__Count"], 5);
  const c = codegenC(compiled.ir!, "abcd").plc_program_c;
  assert.match(c, /goto l\d+;/);
  assert.match(c, /==/);
});

test("structured text calls another ST program", () => {
  const caller = `PROGRAM Main
VAR
  Run : BOOL := TRUE;
  Lamp : BOOL;
END_VAR
Aux(A := Run, Q => Lamp);
END_PROGRAM
`;
  const callee = `PROGRAM Aux
VAR_INPUT
  A : BOOL;
END_VAR
VAR_OUTPUT
  Q : BOOL;
END_VAR
Q := NOT A;
END_PROGRAM
`;
  const compiled = compileTasksToIr(
    project([
      { id: "main", name: "Main", source: "src/main.st", language: "st" },
      { id: "aux", name: "Aux", source: "src/aux.st", language: "st" },
    ]),
    new Map<string, unknown>([
      ["main", caller],
      ["aux", callee],
    ])
  );
  assert.equal(compiled.ok, true, compiled.diagnostics.map((item) => item.message).join("; "));
  const snap = new PlcSimulator(compiled.ir!).stepOnce();
  assert.equal(snap.vars["main__Lamp"], false);
});

test("structured text rejects CASE", () => {
  const source = `PROGRAM Main
VAR
  Mode : INT;
END_VAR
CASE Mode OF
  1: Mode := 2;
END_CASE
END_PROGRAM
`;
  const compiled = compileTasksToIr(
    project([{ id: "main", name: "Main", source: "src/main.st", language: "st" }]),
    new Map([["main", source]])
  );
  assert.equal(compiled.ok, false);
  assert.ok(compiled.diagnostics.some((item) => item.code === "NP-0502"));
});
