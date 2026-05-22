import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "./constants";
import type { CompileDiagnostic, FbdSource, NanoPlcProject } from "./types";

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
  if (!o.scan || typeof o.scan !== "object") {
    diagnostics.push(diag("NP-0104", "Project scan section is required."));
  }
  if (!Array.isArray(o.programs) || o.programs.length === 0) {
    diagnostics.push(diag("NP-0105", "At least one program entry is required."));
  }
  if (diagnostics.some((d) => d.severity === "error")) {
    return { diagnostics };
  }
  return { project: raw as NanoPlcProject, diagnostics };
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
  if (diagnostics.some((d) => d.severity === "error")) {
    return { diagnostics };
  }
  return { fbd: raw as FbdSource, diagnostics };
}
