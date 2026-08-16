import type {
  NanoPlcProgramRef,
  NanoPlcProject,
  NanoPlcTaskRef,
  PlcTaskKind,
} from "./types";
import { PLC_TASK_KINDS } from "./types";

export const DEFAULT_MAIN_TASK_ID = "main_task";
export const DEFAULT_MAIN_TASK_NAME = "MainTask";
export const DEFAULT_TASK_PRIORITY = 1;
export const DEFAULT_EXTRA_TASK_PRIORITY = 10;
export const MIN_TASK_PRIORITY = 0;
export const MAX_TASK_PRIORITY = 31;
export const DEFAULT_CYCLIC_INTERVAL_MS = 10;
export const DEFAULT_WATCHDOG_TIME_MS = 50;

export function isPlcTaskKind(value: unknown): value is PlcTaskKind {
  return typeof value === "string" && (PLC_TASK_KINDS as readonly string[]).includes(value);
}

export function defaultMainTask(
  periodMs: number,
  programId?: string
): NanoPlcTaskRef {
  const interval = periodMs > 0 ? periodMs : DEFAULT_CYCLIC_INTERVAL_MS;
  return {
    id: DEFAULT_MAIN_TASK_ID,
    name: DEFAULT_MAIN_TASK_NAME,
    kind: "cyclic",
    priority: DEFAULT_TASK_PRIORITY,
    interval_ms: interval,
    watchdog: { enabled: true, time_ms: Math.max(DEFAULT_WATCHDOG_TIME_MS, interval * 5) },
    program: programId,
  };
}

/** Entry PROGRAM id for a task (`program`, else legacy `pous[0]`). */
export function taskEntryProgramId(task: NanoPlcTaskRef): string | undefined {
  if (typeof task.program === "string" && task.program.trim() !== "") {
    return task.program;
  }
  const first = task.pous?.[0]?.program;
  return typeof first === "string" && first.trim() !== "" ? first : undefined;
}

/** Assign or clear the single entry PROGRAM. Drops legacy `pous`. */
export function setTaskProgram(task: NanoPlcTaskRef, programId: string | undefined): void {
  if (programId && programId.trim() !== "") {
    task.program = programId.trim();
  } else {
    delete task.program;
  }
  delete task.pous;
}

/** Fold legacy `pous[]` into `program` (mutates). */
export function normalizeTask(task: NanoPlcTaskRef): void {
  const id = taskEntryProgramId(task);
  setTaskProgram(task, id);
}

/**
 * Resolve Task Configuration. Legacy projects without `tasks[]` get a synthetic
 * MainTask (cyclic, `scan.period_ms`, first program).
 */
export function resolveTaskConfiguration(project: NanoPlcProject): NanoPlcTaskRef[] {
  if (project.tasks && project.tasks.length > 0) {
    return project.tasks;
  }
  const period = project.scan?.period_ms ?? DEFAULT_CYCLIC_INTERVAL_MS;
  return [defaultMainTask(period, project.programs[0]?.id)];
}

/** Persist synthesized tasks onto the project object (mutates). */
export function ensureProjectTasks(project: NanoPlcProject): NanoPlcTaskRef[] {
  if (!project.tasks || project.tasks.length === 0) {
    project.tasks = resolveTaskConfiguration(project);
  }
  for (const task of project.tasks) {
    normalizeTask(task);
  }
  return project.tasks;
}

/**
 * Primary cyclic task: MainTask by id/name, else highest priority (lowest number)
 * among cyclic tasks, else the first task.
 */
export function primaryCyclicTask(tasks: NanoPlcTaskRef[]): NanoPlcTaskRef | undefined {
  const cyclic = tasks.filter((t) => t.kind === "cyclic");
  const pool = cyclic.length > 0 ? cyclic : tasks;
  if (pool.length === 0) {
    return undefined;
  }
  const named = pool.find((t) => t.id === DEFAULT_MAIN_TASK_ID || t.name === DEFAULT_MAIN_TASK_NAME);
  if (named) {
    return named;
  }
  return [...pool].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name))[0];
}

export function projectScanPeriodMs(project: NanoPlcProject): number {
  const primary = primaryCyclicTask(resolveTaskConfiguration(project));
  if (primary?.kind === "cyclic" && primary.interval_ms && primary.interval_ms > 0) {
    return primary.interval_ms;
  }
  if (project.scan?.period_ms && project.scan.period_ms > 0) {
    return project.scan.period_ms;
  }
  return DEFAULT_CYCLIC_INTERVAL_MS;
}

/** Keep legacy `scan.period_ms` aligned with the primary cyclic task. */
export function syncScanFromTasks(project: NanoPlcProject): void {
  if (project.tasks) {
    for (const task of project.tasks) {
      normalizeTask(task);
    }
  }
  project.scan = { period_ms: projectScanPeriodMs(project) };
}

/** PROGRAM assigned to the primary cyclic task (compile/runtime T0 entry). */
export function entryProgram(project: NanoPlcProject): NanoPlcProgramRef | undefined {
  const tasks = resolveTaskConfiguration(project);
  const primary = primaryCyclicTask(tasks);
  const programId = primary ? taskEntryProgramId(primary) : undefined;
  if (programId) {
    const found = project.programs.find((p) => p.id === programId);
    if (found) {
      return found;
    }
  }
  return project.programs[0];
}

export function taskKindLabel(kind: PlcTaskKind): string {
  switch (kind) {
    case "cyclic":
      return "Cyclic";
    case "freewheeling":
      return "Freewheeling";
    case "event":
      return "Event";
    default:
      return kind;
  }
}

export function taskDescription(task: NanoPlcTaskRef): string {
  const prio = `Prio ${task.priority}`;
  if (task.kind === "cyclic") {
    const ms = task.interval_ms && task.interval_ms > 0 ? `${task.interval_ms} ms` : "? ms";
    return `${taskKindLabel(task.kind)} · ${ms} · ${prio}`;
  }
  if (task.kind === "event") {
    const ev = task.event?.trim() ? task.event.trim() : "no event";
    return `${taskKindLabel(task.kind)} · ${ev} · ${prio}`;
  }
  return `${taskKindLabel(task.kind)} · ${prio}`;
}

export function findTask(project: NanoPlcProject, taskId: string): NanoPlcTaskRef | undefined {
  return resolveTaskConfiguration(project).find((t) => t.id === taskId);
}
