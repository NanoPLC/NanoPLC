/**
 * Golden scenarios (docs/VIRTUAL_PLC_PLAN.md §8): one input trace with expected
 * values, run against both the TS simulator and the generated C on the host.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { codegenC, collectTypedVars, cTimerName, cTypeFor, cVarName } from "../codegen/cGenerator";
import { compileProjectToIr, compileTasksToIr } from "../compileFbd";
import { irPrimaryPeriodMs } from "../irTasks";
import { defaultMainTask } from "../tasks";
import { compileProjectDir, loadProjectFbdSourcesFromDisk, loadProjectIoProfile } from "../projectDisk";
import { FBD_SOURCE_SCHEMA_VERSION, IO_MAP_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "../constants";
import { PlcSimulator } from "../simulator/PlcSimulator";
import type { IoMap, NanoPlcProject, NanoPlcTaskRef, PlcIr, PlcPrimitiveType } from "../types";

export type GoldenValue = boolean | number;

export interface GoldenStep {
  /** DI / AI symbols or IR variable names, applied before the first scan of this step. Inputs persist. */
  set?: Record<string, GoldenValue>;
  /** Number of scans to run (default 1). */
  scans?: number;
  /** Values checked after the last scan. Keys are IR variable names or `<timer block id>.ET`. */
  expect: Record<string, GoldenValue>;
}

export interface GoldenScenario {
  name: string;
  description?: string;
  /** Directory under `examples/` with `nanoplc.project.json`. */
  example?: string;
  /** Inline FBD programs keyed by program id (used when `example` is omitted). */
  programs?: Record<string, unknown>;
  /** Entry program id (default: the primary task's program for examples, else `main`). */
  entry?: string;
  /** Scan period in ms for inline programs (default 10). */
  period_ms?: number;
  /** Task Configuration for inline programs (default: one MainTask running `entry`). A step's scan is one primary interval. */
  tasks?: NanoPlcTaskRef[];
  steps: GoldenStep[];
}

export interface GoldenObservation {
  step: number;
  key: string;
  expected: GoldenValue;
  actual: GoldenValue;
}

/** Values after each step, in `expect` key order. */
export type GoldenTrace = GoldenValue[][];

export function loadGoldenScenarios(dir: string): GoldenScenario[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".golden.json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as GoldenScenario);
}

export function compileGoldenScenario(scenario: GoldenScenario, examplesDir: string): PlcIr {
  let project: NanoPlcProject;
  const sources = new Map<string, unknown>();
  let ioMap: IoMap | undefined;
  let entry = scenario.entry;

  if (scenario.example && !entry) {
    const result = compileProjectDir(join(examplesDir, scenario.example));
    if (!result.ok || !result.ir) {
      const msg = result.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ");
      throw new Error(`Golden scenario "${scenario.name}" does not compile: ${msg}`);
    }
    return result.ir;
  }
  if (scenario.example) {
    const root = join(examplesDir, scenario.example);
    project = JSON.parse(readFileSync(join(root, "nanoplc.project.json"), "utf8"));
    for (const [id, src] of loadProjectFbdSourcesFromDisk(root, project)) {
      sources.set(id, src);
    }
    const merged = loadProjectIoProfile(root, project).ioMap;
    ioMap = merged.entries.length > 0 ? merged : undefined;
  } else {
    const ids = Object.keys(scenario.programs ?? {});
    project = {
      schema_version: PROJECT_SCHEMA_VERSION,
      name: scenario.name,
      device: { board: "esp32-s3", idf_target: "esp32s3" },
      scan: { period_ms: scenario.period_ms ?? 10 },
      programs: ids.map((id) => ({ id, name: id, source: `src/${id}.fbd.json`, language: "fbd" })),
      tasks: scenario.tasks ?? [defaultMainTask(scenario.period_ms ?? 10, entry ?? "main")],
    };
    for (const id of ids) {
      sources.set(id, { schema_version: FBD_SOURCE_SCHEMA_VERSION, name: id, ...(scenario.programs![id] as object) });
    }
    ioMap = { schema_version: IO_MAP_SCHEMA_VERSION, entries: [] };
    const tasksResult = compileTasksToIr(project, sources, ioMap);
    if (!tasksResult.ok || !tasksResult.ir) {
      const msg = tasksResult.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ");
      throw new Error(`Golden scenario "${scenario.name}" does not compile: ${msg}`);
    }
    return tasksResult.ir;
  }

  const result = compileProjectToIr(project, sources, entry!, ioMap);
  if (!result.ok || !result.ir) {
    const msg = result.diagnostics.map((d) => `${d.code} ${d.message}`).join("; ");
    throw new Error(`Golden scenario "${scenario.name}" does not compile: ${msg}`);
  }
  return result.ir;
}

function ioIndex(ir: PlcIr, kind: "di" | "ai", symbol: string): number | undefined {
  return ir.io_image[kind].find((e) => e.symbol === symbol)?.index;
}

export function runGoldenSimulator(ir: PlcIr, scenario: GoldenScenario): GoldenTrace {
  const sim = new PlcSimulator(ir);
  return scenario.steps.map((step) => {
    for (const [key, value] of Object.entries(step.set ?? {})) {
      const di = ioIndex(ir, "di", key);
      const ai = ioIndex(ir, "ai", key);
      if (di !== undefined) {
        sim.setDi(di, Boolean(value));
      } else if (ai !== undefined) {
        sim.setAi(ai, Number(value));
      } else {
        sim.setVar(key, value);
      }
    }
    let snap = sim.currentSnapshot();
    for (let i = 0; i < (step.scans ?? 1); i++) {
      snap = sim.stepOnce();
    }
    return Object.keys(step.expect).map((key) => snap.vars[key]);
  });
}

function goldenEqual(expected: GoldenValue, actual: GoldenValue | undefined): boolean {
  if (typeof expected === "boolean") {
    return actual === expected || actual === (expected ? 1 : 0);
  }
  return typeof actual === "number" && Math.fround(actual) === Math.fround(expected);
}

/** Differences between a trace and the scenario's `expect` values. */
export function goldenMismatches(scenario: GoldenScenario, trace: GoldenTrace): GoldenObservation[] {
  const out: GoldenObservation[] = [];
  scenario.steps.forEach((step, i) => {
    Object.entries(step.expect).forEach(([key, expected], k) => {
      const actual = trace[i]?.[k];
      if (!goldenEqual(expected, actual)) {
        out.push({ step: i, key, expected, actual: actual as GoldenValue });
      }
    });
  });
  return out;
}

function cExpr(key: string): string {
  return key.endsWith(".ET") ? `${cTimerName(key.slice(0, -3))}.et_ms` : cVarName(key);
}

function cAssign(key: string, value: GoldenValue, ir: PlcIr, types: Map<string, PlcPrimitiveType>): string {
  const di = ioIndex(ir, "di", key);
  if (di !== undefined) {
    return `    h_di[${di}] = ${value ? "true" : "false"};`;
  }
  const ai = ioIndex(ir, "ai", key);
  if (ai !== undefined) {
    return `    h_ai[${ai}] = (float)${Number(value)};`;
  }
  const type = types.get(key) ?? "BOOL";
  const literal = type === "BOOL" ? (value ? "true" : "false") : `(${cTypeFor(type)})${Number(value)}`;
  return `    ${cVarName(key)} = ${literal};`;
}

function cPrint(key: string, types: Map<string, PlcPrimitiveType>): string {
  if (key.endsWith(".ET")) {
    return `    printf(" %lu", (unsigned long)${cExpr(key)});`;
  }
  return types.get(key) === "REAL"
    ? `    printf(" %.9g", (double)${cExpr(key)});`
    : `    printf(" %ld", (long)${cExpr(key)});`;
}

/** C `main()` that replays the scenario against `plc_program.c` with stub HAL. */
export function goldenCHarness(ir: PlcIr, scenario: GoldenScenario): string {
  const types = new Map(collectTypedVars(ir).map((v) => [v.name, v.type]));
  const body = scenario.steps.flatMap((step) => [
    ...Object.entries(step.set ?? {}).map(([k, v]) => cAssign(k, v, ir, types)),
    `    h_advance(${step.scans ?? 1}u * ${irPrimaryPeriodMs(ir)}u);`,
    ...Object.keys(step.expect).map((k) => cPrint(k, types)),
    `    printf("\\n");`,
  ]);
  return `#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "nanoplc_hal.h"

static bool h_di[NANOPLC_HAL_MAX_DI];
static float h_ai[NANOPLC_HAL_MAX_AI];
static bool h_do[NANOPLC_HAL_MAX_DO];

static bool h_failsafe_outputs_off;

bool nanoplc_hal_read_di(size_t index) { return index < NANOPLC_HAL_MAX_DI && h_di[index]; }
float nanoplc_hal_read_ai(size_t index) { return index < NANOPLC_HAL_MAX_AI ? h_ai[index] : 0.0f; }
void nanoplc_hal_write_do(size_t index, bool value)
{
    if (h_failsafe_outputs_off) {
        return;
    }
    if (index < NANOPLC_HAL_MAX_DO) {
        h_do[index] = value;
    }
}
void nanoplc_hal_force_outputs_off(void)
{
    h_failsafe_outputs_off = true;
    for (size_t i = 0; i < NANOPLC_HAL_MAX_DO; i++) {
        h_do[i] = false;
    }
}

#include "plc_program.c"

/* Same virtual-time scheduler as PlcSimulator.advance(). */
#define H_TASKS_MAX 16
#define H_DUE_NEVER 0xffffffffu
static const nanoplc_task_desc_t *h_tasks;
static size_t h_count;
static uint32_t h_now;
static uint32_t h_due[H_TASKS_MAX];
static uint32_t h_last[H_TASKS_MAX];
static bool h_event_prev[H_TASKS_MAX];
static bool h_event_ran[H_TASKS_MAX];

static uint32_t h_period(const nanoplc_task_desc_t *t)
{
    return (t->kind == NANOPLC_TASK_CYCLIC && t->interval_ms > 0u) ? t->interval_ms : 1u;
}

static bool h_event_level(const nanoplc_task_desc_t *t)
{
    if (t->event_kind == NANOPLC_EVENT_DI) {
        return nanoplc_hal_read_di(t->event_di_index);
    }
    if (t->event_kind == NANOPLC_EVENT_VAR && t->event_var != NULL) {
        return *t->event_var;
    }
    return false;
}

static void h_sample_events(uint32_t now)
{
    for (size_t i = 0; i < h_count; i++) {
        if (h_tasks[i].kind != NANOPLC_TASK_EVENT) {
            continue;
        }
        const bool cur = h_event_level(&h_tasks[i]);
        if (cur && !h_event_prev[i]) {
            h_due[i] = now;
        }
        h_event_prev[i] = cur;
    }
}

static void h_advance(uint32_t ms)
{
    const uint32_t target = h_now + ms;
    h_sample_events(h_now);
    for (;;) {
        size_t best = h_count;
        for (size_t i = 0; i < h_count; i++) {
            if (h_due[i] > target) {
                continue;
            }
            if (best == h_count || h_due[i] < h_due[best] ||
                (h_due[i] == h_due[best] && h_tasks[i].priority < h_tasks[best].priority)) {
                best = i;
            }
        }
        if (best == h_count) {
            break;
        }
        const nanoplc_task_desc_t *t = &h_tasks[best];
        const uint32_t now = h_due[best];
        uint32_t dt;
        if (t->kind == NANOPLC_TASK_CYCLIC) {
            dt = h_period(t);
        } else if (t->kind == NANOPLC_TASK_EVENT) {
            dt = h_event_ran[best] ? (now - h_last[best]) : 0u;
        } else {
            dt = now - h_last[best];
        }
        t->run(dt);
        h_last[best] = now;
        if (t->kind == NANOPLC_TASK_EVENT) {
            h_due[best] = H_DUE_NEVER;
            h_event_ran[best] = true;
        } else {
            h_due[best] = now + h_period(t);
        }
        h_sample_events(now);
    }
    h_now = target;
}

int main(void)
{
    (void)h_do;
    h_tasks = nanoplc_generated_tasks(&h_count);
    if (h_count > H_TASKS_MAX) {
        return 3;
    }
    for (size_t i = 0; i < h_count; i++) {
        if (h_tasks[i].kind == NANOPLC_TASK_EVENT) {
            h_due[i] = H_DUE_NEVER;
            h_event_prev[i] = h_event_level(&h_tasks[i]);
            h_event_ran[i] = false;
            h_last[i] = 0;
        } else {
            h_due[i] = h_period(&h_tasks[i]);
            h_last[i] = 0;
        }
    }
${body.join("\n")}
    return 0;
}
`;
}

/** First working host C compiler: `$NANOPLC_CC`, `$CC`, then `cc`, `gcc`, `clang`. */
export function findHostCCompiler(): string | undefined {
  const candidates = [process.env.NANOPLC_CC, process.env.CC, "cc", "gcc", "clang"].filter(
    (c): c is string => Boolean(c)
  );
  return candidates.find((c) => spawnSync(c, ["--version"], { stdio: "ignore", shell: false }).status === 0);
}

function parseCTrace(stdout: string, scenario: GoldenScenario): GoldenTrace {
  const lines = stdout.trim().split(/\r?\n/);
  return scenario.steps.map((_, i) =>
    (lines[i] ?? "")
      .trim()
      .split(/\s+/)
      .filter((s) => s !== "")
      .map(Number)
  );
}

/**
 * Build `plc_program.c` + harness with the host compiler and run it.
 * Uses UBSan when the toolchain supports it, so C undefined behavior fails the run.
 */
export function runGoldenC(
  ir: PlcIr,
  scenario: GoldenScenario,
  compiler: string,
  firmwareDir: string
): GoldenTrace {
  const dir = mkdtempSync(join(tmpdir(), "nanoplc-golden-"));
  const fwDir = resolve(firmwareDir);
  try {
    const { plc_program_c } = codegenC(ir, "0".repeat(64));
    writeFileSync(join(dir, "plc_program.c"), plc_program_c);
    writeFileSync(join(dir, "harness.c"), goldenCHarness(ir, scenario));
    const exe = join(dir, process.platform === "win32" ? "golden.exe" : "golden");
    const base = [
      "-std=c11",
      "-Wall",
      "-Wextra",
      "-Werror",
      "-I",
      join(fwDir, "components", "nanoplc_hal", "include"),
      "-I",
      join(fwDir, "components", "nanoplc_generated", "include"),
      "-o",
      exe,
      join(dir, "harness.c"),
      ...(process.platform === "win32" ? [] : ["-lm"]),
    ];
    const ubsan = ["-fsanitize=undefined", "-fno-sanitize-recover=all"];
    let build = spawnSync(compiler, [...ubsan, ...base], { cwd: dir, encoding: "utf8" });
    if (build.status !== 0) {
      build = spawnSync(compiler, base, { cwd: dir, encoding: "utf8" });
    }
    if (build.status !== 0) {
      throw new Error(`C build failed for "${scenario.name}":\n${build.stderr}${build.stdout}`);
    }
    const run = spawnSync(exe, [], { cwd: dir, encoding: "utf8" });
    if (run.status !== 0) {
      throw new Error(`C run failed for "${scenario.name}" (exit ${run.status}):\n${run.stderr}`);
    }
    return parseCTrace(run.stdout, scenario);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
