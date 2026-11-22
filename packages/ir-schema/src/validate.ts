import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "./constants";
import {
  isPlcTaskKind,
  MAX_TASK_PRIORITY,
  MIN_TASK_PRIORITY,
} from "./tasks";
import type { CompileDiagnostic, FbdSource, NanoPlcProject, NanoPlcTaskRef } from "./types";
import { parsePouVariables } from "./pouVars";

function diag(
  code: string,
  message: string,
  severity: CompileDiagnostic["severity"] = "error",
  block_id?: string
): CompileDiagnostic {
  return { code, message, severity, block_id };
}

export function validateProject(raw: unknown): { project?: NanoPlcProject; diagnostics: CompileDiagnostic[] } {
  const diagnostics: CompileDiagnostic[] = [];
  if (raw == null || typeof raw !== "object") {
    return { diagnostics: [diag("NP-0100", "Project file must be a JSON object.")] };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== PROJECT_SCHEMA_VERSION) {
    diagnostics.push(
      diag("NP-0101", `Unsupported project schema_version (expected ${PROJECT_SCHEMA_VERSION}).`)
    );
  }
  if (typeof o.name !== "string" || o.name.trim() === "") {
    diagnostics.push(diag("NP-0102", "Project name is required."));
  }
  if (!o.device || typeof o.device !== "object") {
    diagnostics.push(diag("NP-0103", "Project device section is required."));
  }
  const hasScan =
    o.scan !== undefined &&
    typeof o.scan === "object" &&
    o.scan !== null &&
    typeof (o.scan as { period_ms?: unknown }).period_ms === "number";
  const hasTasks = Array.isArray(o.tasks) && o.tasks.length > 0;
  if (!hasScan && !hasTasks) {
    diagnostics.push(
      diag("NP-0104", "Project must define scan.period_ms or at least one task.")
    );
  }
  if (!Array.isArray(o.programs) || o.programs.length === 0) {
    diagnostics.push(diag("NP-0105", "At least one program entry is required."));
  }
  if (Array.isArray(o.tasks)) {
    diagnostics.push(
      ...validateTasks(
        o.tasks,
        Array.isArray(o.programs) ? o.programs : []
      )
    );
  }
  if (diagnostics.some((d) => d.severity === "error")) {
    return { diagnostics };
  }
  return { project: raw as NanoPlcProject, diagnostics };
}

function validateTasks(rawTasks: unknown[], rawPrograms: unknown[]): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];
  const programIds = new Set<string>();
  for (const p of rawPrograms) {
    if (p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string") {
      programIds.add((p as { id: string }).id);
    }
  }

  const taskIds = new Set<string>();
  const programOwners = new Map<string, string[]>();

  for (const raw of rawTasks) {
    if (raw == null || typeof raw !== "object") {
      diagnostics.push(diag("NP-0106", "Each task must be an object."));
      continue;
    }
    const t = raw as Partial<NanoPlcTaskRef> & Record<string, unknown>;
    if (typeof t.id !== "string" || t.id.trim() === "") {
      diagnostics.push(diag("NP-0106", "Task id is required."));
      continue;
    }
    if (taskIds.has(t.id)) {
      diagnostics.push(diag("NP-0107", `Duplicate task id "${t.id}".`));
    }
    taskIds.add(t.id);
    if (typeof t.name !== "string" || t.name.trim() === "") {
      diagnostics.push(diag("NP-0106", `Task "${t.id}" name is required.`));
    }
    if (!isPlcTaskKind(t.kind)) {
      diagnostics.push(
        diag("NP-0106", `Task "${t.id}" kind must be cyclic, freewheeling, or event.`)
      );
    }
    if (typeof t.priority !== "number" || !Number.isInteger(t.priority)) {
      diagnostics.push(diag("NP-0110", `Task "${t.id}" priority must be an integer.`));
    } else if (t.priority < MIN_TASK_PRIORITY || t.priority > MAX_TASK_PRIORITY) {
      diagnostics.push(
        diag(
          "NP-0110",
          `Task "${t.id}" priority must be ${MIN_TASK_PRIORITY}..${MAX_TASK_PRIORITY} (0 = highest).`
        )
      );
    }
    if (t.kind === "cyclic") {
      if (typeof t.interval_ms !== "number" || !(t.interval_ms > 0)) {
        diagnostics.push(
          diag("NP-0109", `Cyclic task "${t.id}" requires interval_ms > 0.`)
        );
      }
    }
    if (t.kind === "event" && (typeof t.event !== "string" || t.event.trim() === "")) {
      diagnostics.push(
        diag("NP-0112", `Event task "${t.id}" has no event variable yet.`, "warning")
      );
    }
    if (t.watchdog?.enabled) {
      if (typeof t.watchdog.time_ms !== "number" || !(t.watchdog.time_ms > 0)) {
        diagnostics.push(diag("NP-0120", `Task "${t.id}" watchdog requires time_ms > 0.`));
      }
      const action = t.watchdog.on_timeout;
      if (action !== undefined && action !== "hold" && action !== "outputs_off") {
        diagnostics.push(
          diag("NP-0120", `Task "${t.id}" watchdog on_timeout must be hold or outputs_off.`)
        );
      }
    }

    const fromField = typeof t.program === "string" ? t.program.trim() : "";
    const pous = Array.isArray(t.pous) ? t.pous : undefined;
    if (pous && pous.length > 1) {
      diagnostics.push(
        diag(
          "NP-0116",
          `Task "${t.id}" must run exactly one program. Put extra programs on their own tasks, or call them from a program later.`
        )
      );
    }
    const fromPous =
      pous && pous[0] && typeof pous[0] === "object"
        ? String((pous[0] as { program?: unknown }).program ?? "").trim()
        : "";
    const programId = fromField || fromPous;
    if (!programId) {
      diagnostics.push(
        diag("NP-0113", `Task "${t.id}" has no entry program.`, "warning")
      );
      continue;
    }
    if (!programIds.has(programId)) {
      diagnostics.push(
        diag("NP-0108", `Task "${t.id}" references unknown program "${programId}".`)
      );
    }
    const owners = programOwners.get(programId) ?? [];
    owners.push(t.id);
    programOwners.set(programId, owners);
  }

  for (const [programId, owners] of programOwners) {
    if (owners.length > 1) {
      diagnostics.push(
        diag(
          "NP-0115",
          `Program "${programId}" is called by multiple tasks (${owners.join(", ")}).`,
          "warning"
        )
      );
    }
  }

  return diagnostics;
}

export function validateFbdSource(raw: unknown): { fbd?: FbdSource; diagnostics: CompileDiagnostic[] } {
  const diagnostics: CompileDiagnostic[] = [];
  if (raw == null || typeof raw !== "object") {
    return { diagnostics: [diag("NP-0200", "FBD source must be a JSON object.")] };
  }
  const o = raw as Record<string, unknown>;
  if (o.schema_version !== FBD_SOURCE_SCHEMA_VERSION) {
    diagnostics.push(
      diag("NP-0201", `Unsupported FBD schema_version (expected ${FBD_SOURCE_SCHEMA_VERSION}).`)
    );
  }
  if (typeof o.name !== "string") {
    diagnostics.push(diag("NP-0202", "FBD network name is required."));
  }
  if (!Array.isArray(o.blocks)) {
    diagnostics.push(diag("NP-0203", "FBD blocks array is required."));
  }
  if (!Array.isArray(o.wires)) {
    diagnostics.push(diag("NP-0204", "FBD wires array is required."));
  }
  if (o.variables !== undefined) {
    diagnostics.push(...parsePouVariables(o.variables).diagnostics);
  }
  if (diagnostics.some((d) => d.severity === "error")) {
    return { diagnostics };
  }
  return { fbd: raw as FbdSource, diagnostics };
}
