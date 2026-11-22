import assert from "node:assert/strict";
import { test } from "node:test";

import { compileTasksToIr } from "../compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "../constants";
import { PlcSimulator } from "./PlcSimulator";
import type { FbdSource, NanoPlcProject, NanoPlcTaskRef } from "../types";

/** Acc := Acc + 1 every pass. */
function counterFbd(name: string): FbdSource {
  return {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name,
    variables: [{ name: "Acc", class: "VAR", type: "DINT" }],
    blocks: [
      { id: "acc_r", type: "LOCAL", params: { name: "Acc" } },
      { id: "one", type: "CONST", params: { data_type: "DINT", value: 1 } },
      { id: "add1", type: "ADD" },
      { id: "acc_w", type: "LOCAL", params: { name: "Acc" } },
    ],
    wires: [
      { from: { block: "acc_r", port: "Q" }, to: { block: "add1", port: "IN1" } },
      { from: { block: "one", port: "Q" }, to: { block: "add1", port: "IN2" } },
      { from: { block: "add1", port: "Q" }, to: { block: "acc_w", port: "IN" } },
    ],
  };
}

/** DO channel 1 := `value`. */
function driveDoFbd(name: string, value: boolean): FbdSource {
  return {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name,
    blocks: [
      { id: "k", type: "CONST", params: { data_type: "BOOL", value } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
    ],
    wires: [{ from: { block: "k", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
}

/** DO_Done := TON(TRUE, PT). */
function tonFbd(name: string, ptMs: number): FbdSource {
  return {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name,
    blocks: [
      { id: "k", type: "CONST", params: { data_type: "BOOL", value: true } },
      { id: "t1", type: "TON", params: { pt_ms: ptMs } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Done" } },
    ],
    wires: [
      { from: { block: "k", port: "Q" }, to: { block: "t1", port: "IN" } },
      { from: { block: "t1", port: "Q" }, to: { block: "do1", port: "IN" } },
    ],
  };
}

function project(tasks: NanoPlcTaskRef[], programIds: string[]): NanoPlcProject {
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    name: "multitask",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs: programIds.map((id) => ({ id, name: id, source: `src/${id}.fbd.json`, language: "fbd" })),
    tasks,
  };
}

function cyclic(id: string, program: string, interval_ms: number, priority: number): NanoPlcTaskRef {
  return { id, name: id, kind: "cyclic", priority, interval_ms, program };
}

test("compileTasksToIr lists every task and marks the primary one", () => {
  const result = compileTasksToIr(
    project([cyclic("MainTask", "fast", 10, 1), cyclic("Slow", "slow", 50, 2)], ["fast", "slow"]),
    new Map<string, unknown>([
      ["fast", counterFbd("Fast")],
      ["slow", counterFbd("Slow")],
    ])
  );
  assert.ok(result.ok && result.ir, JSON.stringify(result.diagnostics));
  const ir = result.ir;
  assert.deepEqual(
    ir.tasks?.map((t) => [t.id, t.program, t.interval_ms, t.primary ?? false]),
    [
      ["MainTask", "fast", 10, true],
      ["Slow", "slow", 50, false],
    ]
  );
  assert.deepEqual(ir.schedule, ir.tasks?.[0].schedule);
  assert.equal(ir.pou_schedules, undefined, "task entries are not CALL targets");
  assert.ok(ir.variables.some((v) => v.name === "slow__Acc"));
});

test("simulator runs each cyclic task at its own interval", () => {
  const result = compileTasksToIr(
    project([cyclic("MainTask", "fast", 10, 1), cyclic("Slow", "slow", 50, 2)], ["fast", "slow"]),
    new Map<string, unknown>([
      ["fast", counterFbd("Fast")],
      ["slow", counterFbd("Slow")],
    ])
  );
  assert.ok(result.ir);
  const sim = new PlcSimulator(result.ir);
  assert.equal(sim.scanPeriodMs, 10);
  const snap = sim.advance(100);
  assert.equal(snap.vars["fast__Acc"], 10);
  assert.equal(snap.vars["slow__Acc"], 2);
  assert.equal(snap.scan_index, 10);
  assert.deepEqual(snap.task_passes, { MainTask: 10, Slow: 2 });
  assert.equal(snap.elapsed_ms, 100);

  for (let i = 0; i < 4; i++) {
    sim.stepOnce();
  }
  assert.equal(sim.currentSnapshot().vars["slow__Acc"], 2);
  assert.equal(sim.stepOnce().vars["slow__Acc"], 3);
});

test("simulator runs the higher-priority task first when passes coincide", () => {
  // Both drive DO_Lamp; the pass that runs last at t=20 decides the output.
  const result = compileTasksToIr(
    project([cyclic("MainTask", "on", 10, 0), cyclic("Off", "off", 20, 5)], ["on", "off"]),
    new Map<string, unknown>([
      ["on", driveDoFbd("On", true)],
      ["off", driveDoFbd("Off", false)],
    ])
  );
  assert.ok(result.ir, JSON.stringify(result.diagnostics));
  const sim = new PlcSimulator(result.ir);
  assert.equal(sim.stepOnce().do[0], true, "t=10: only MainTask");
  assert.equal(sim.stepOnce().do[0], false, "t=20: MainTask (prio 0) then Off (prio 5)");
  assert.equal(sim.stepOnce().do[0], true, "t=30: only MainTask");
});

test("freewheeling task passes every virtual millisecond with dt = 1", () => {
  const free: NanoPlcTaskRef = { id: "Free", name: "Free", kind: "freewheeling", priority: 10, program: "bg" };
  const result = compileTasksToIr(
    project([cyclic("MainTask", "main", 10, 1), free], ["main", "bg"]),
    new Map<string, unknown>([
      ["main", counterFbd("Main")],
      ["bg", tonFbd("Bg", 5)],
    ])
  );
  assert.ok(result.ir, JSON.stringify(result.diagnostics));
  const sim = new PlcSimulator(result.ir);
  assert.equal(sim.advance(4).vars["DO_Done"], false);
  const snap = sim.advance(1);
  assert.equal(snap.vars["DO_Done"], true);
  assert.equal(snap.task_passes["Free"], 5);
  assert.equal(snap.scan_index, 0);
});

test("event tasks compile with NP-0118 and do not run", () => {
  const ev: NanoPlcTaskRef = { id: "Ev", name: "Ev", kind: "event", priority: 3, event: "DI_Start", program: "ev" };
  const result = compileTasksToIr(
    project([cyclic("MainTask", "main", 10, 1), ev], ["main", "ev"]),
    new Map<string, unknown>([
      ["main", counterFbd("Main")],
      ["ev", counterFbd("Ev")],
    ])
  );
  assert.ok(result.ir);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0118" && d.severity === "warning"));
  const snap = new PlcSimulator(result.ir).advance(50);
  assert.equal(snap.vars["main__Acc"], 5);
  assert.equal(snap.vars["ev__Acc"], 0);
  assert.equal(snap.task_passes["Ev"], undefined);
});

test("a program called from two tasks warns NP-0117 and is a single POU", () => {
  const caller = (name: string): FbdSource => ({
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name,
    blocks: [{ id: "c", type: "CALL", params: { program: "shared" } }],
    wires: [],
  });
  const result = compileTasksToIr(
    project([cyclic("MainTask", "a", 10, 1), cyclic("B", "b", 20, 2)], ["a", "b", "shared"]),
    new Map<string, unknown>([
      ["a", caller("A")],
      ["b", caller("B")],
      ["shared", counterFbd("Shared")],
    ])
  );
  assert.ok(result.ir, JSON.stringify(result.diagnostics));
  const warn = result.diagnostics.find((d) => d.code === "NP-0117");
  assert.ok(warn && warn.program_id === "shared");
  assert.deepEqual(
    result.ir.pou_schedules?.map((p) => p.id),
    ["shared"]
  );
  assert.equal(new PlcSimulator(result.ir).advance(20).vars["shared__Acc"], 3);
});

test("single-task project has one primary task", () => {
  const result = compileTasksToIr(
    project([cyclic("MainTask", "main", 20, 1)], ["main"]),
    new Map<string, unknown>([["main", counterFbd("Main")]])
  );
  assert.ok(result.ir);
  assert.equal(result.ir.tasks?.length, 1);
  assert.equal(result.ir.tasks?.[0].primary, true);
  const sim = new PlcSimulator(result.ir);
  assert.equal(sim.scanPeriodMs, 20);
  assert.equal(sim.stepOnce().vars["main__Acc"], 1);
});
