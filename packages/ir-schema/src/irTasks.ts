import { DEFAULT_MAIN_TASK_ID, DEFAULT_MAIN_TASK_NAME } from "./tasks";
import type { IrTask, PlcIr } from "./types";

/** Virtual period of a freewheeling task: one pass per 1 ms RTOS tick. */
export const FREEWHEEL_PERIOD_MS = 1;

const LEGACY_SCAN_PERIOD_MS = 10;

/**
 * Tasks of a compiled IR. IR without `tasks[]` (single-program compile) runs
 * `schedule` as one cyclic primary task at `project.scan_period_ms`.
 */
export function irTaskList(ir: PlcIr): IrTask[] {
  if (ir.tasks && ir.tasks.length > 0) {
    return ir.tasks;
  }
  return [
    {
      id: DEFAULT_MAIN_TASK_ID,
      name: DEFAULT_MAIN_TASK_NAME,
      kind: "cyclic",
      priority: 1,
      interval_ms: ir.project.scan_period_ms > 0 ? ir.project.scan_period_ms : LEGACY_SCAN_PERIOD_MS,
      program: ir.project.program,
      primary: true,
      schedule: ir.schedule,
    },
  ];
}

export function irPrimaryTask(ir: PlcIr): IrTask {
  const tasks = irTaskList(ir);
  return tasks.find((t) => t.primary) ?? tasks[0];
}

/** Pass period in virtual time: `interval_ms` for cyclic, 1 ms for freewheeling. */
export function irTaskPeriodMs(task: IrTask): number {
  return task.kind === "cyclic" && task.interval_ms && task.interval_ms > 0
    ? task.interval_ms
    : FREEWHEEL_PERIOD_MS;
}

/** Interval of one `stepOnce` / golden scan: the primary task's period. */
export function irPrimaryPeriodMs(ir: PlcIr): number {
  const primary = irPrimaryTask(ir);
  return primary.kind === "cyclic"
    ? irTaskPeriodMs(primary)
    : ir.project.scan_period_ms > 0
      ? ir.project.scan_period_ms
      : LEGACY_SCAN_PERIOD_MS;
}
