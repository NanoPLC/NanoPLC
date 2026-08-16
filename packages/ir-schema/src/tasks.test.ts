import assert from "node:assert/strict";
import { test } from "node:test";

import { PROJECT_SCHEMA_VERSION } from "./constants";
import {
  defaultMainTask,
  entryProgram,
  primaryCyclicTask,
  projectScanPeriodMs,
  resolveTaskConfiguration,
  syncScanFromTasks,
  taskDescription,
  taskEntryProgramId,
} from "./tasks";
import type { NanoPlcProject } from "./types";
import { validateProject } from "./validate";

function baseProject(over: Partial<NanoPlcProject> = {}): NanoPlcProject {
  return {
    schema_version: PROJECT_SCHEMA_VERSION,
    name: "demo",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
    ...over,
  };
}

test("legacy project without tasks synthesizes MainTask", () => {
  const tasks = resolveTaskConfiguration(baseProject());
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, "main_task");
  assert.equal(tasks[0].kind, "cyclic");
  assert.equal(tasks[0].interval_ms, 10);
  assert.equal(taskEntryProgramId(tasks[0]), "main");
});

test("explicit tasks win over scan.period_ms", () => {
  const project = baseProject({
    scan: { period_ms: 10 },
    tasks: [
      {
        id: "fast",
        name: "FastTask",
        kind: "cyclic",
        priority: 0,
        interval_ms: 5,
        program: "main",
      },
    ],
  });
  assert.equal(projectScanPeriodMs(project), 5);
  assert.equal(entryProgram(project)?.id, "main");
});

test("primaryCyclicTask prefers MainTask over a higher-priority extra task", () => {
  const main = defaultMainTask(20, "main");
  const fast = {
    id: "fast",
    name: "Fast",
    kind: "cyclic" as const,
    priority: 0,
    interval_ms: 5,
    program: "aux",
  };
  const primary = primaryCyclicTask([fast, main]);
  assert.equal(primary?.id, "main_task");
  assert.equal(taskDescription(main), "Cyclic · 20 ms · Prio 1");
});

test("syncScanFromTasks writes primary cyclic interval", () => {
  const project = baseProject({
    tasks: [defaultMainTask(25, "main")],
  });
  syncScanFromTasks(project);
  assert.equal(project.scan?.period_ms, 25);
});

test("validateProject accepts tasks without scan", () => {
  const raw = {
    schema_version: 1,
    name: "demo",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
    tasks: [defaultMainTask(10, "main")],
  };
  const { project, diagnostics } = validateProject(raw);
  assert.ok(project);
  assert.equal(diagnostics.filter((d) => d.severity === "error").length, 0);
});

test("validateProject rejects cyclic task without interval", () => {
  const raw = {
    schema_version: 1,
    name: "demo",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
    tasks: [
      {
        id: "main_task",
        name: "MainTask",
        kind: "cyclic",
        priority: 1,
        program: "main",
      },
    ],
  };
  const { project, diagnostics } = validateProject(raw);
  assert.equal(project, undefined);
  assert.ok(diagnostics.some((d) => d.code === "NP-0109"));
});

test("validateProject errors on unknown program and warns on multi-task call", () => {
  const raw = {
    schema_version: 1,
    name: "demo",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs: [
      { id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" },
      { id: "aux", name: "Aux", source: "src/aux.fbd.json", language: "fbd" },
    ],
    tasks: [
      { ...defaultMainTask(10, "main"), program: "ghost" },
      {
        id: "slow",
        name: "Slow",
        kind: "cyclic",
        priority: 10,
        interval_ms: 100,
        program: "main",
      },
    ],
  };
  const { diagnostics } = validateProject(raw);
  assert.ok(diagnostics.some((d) => d.code === "NP-0108"));
  assert.ok(diagnostics.some((d) => d.code === "NP-0115") === false);
});

test("validateProject rejects more than one program on a task", () => {
  const raw = {
    schema_version: 1,
    name: "demo",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    programs: [
      { id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" },
      { id: "aux", name: "Aux", source: "src/aux.fbd.json", language: "fbd" },
    ],
    tasks: [
      {
        id: "main_task",
        name: "MainTask",
        kind: "cyclic",
        priority: 1,
        interval_ms: 10,
        pous: [{ program: "main" }, { program: "aux" }],
      },
    ],
  };
  const { diagnostics } = validateProject(raw);
  assert.ok(diagnostics.some((d) => d.code === "NP-0116"));
});

test("validateProject warns when the same program is bound to two tasks", () => {
  const raw = {
    schema_version: 1,
    name: "demo",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
    tasks: [
      defaultMainTask(10, "main"),
      {
        id: "slow",
        name: "Slow",
        kind: "cyclic",
        priority: 10,
        interval_ms: 100,
        program: "main",
      },
    ],
  };
  const { project, diagnostics } = validateProject(raw);
  assert.ok(project);
  assert.ok(diagnostics.some((d) => d.code === "NP-0115"));
});
