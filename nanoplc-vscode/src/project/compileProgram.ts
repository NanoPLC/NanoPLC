import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  buildIoMapFromCatalog,
  buildProjectDeviceFields,
  catalogLabel,
  compileFbdToIr,
  DEVICE_CATALOG,
  FBD_SOURCE_SCHEMA_VERSION,
  IO_MAP_SCHEMA_VERSION,
  IR_VERSION,
  PROJECT_SCHEMA_VERSION,
  validateProject,
  type CompileDiagnostic,
  type DeviceCatalogEntry,
  type IoMap,
  type NanoPlcProject,
} from "@nanoplc/ir-schema";

import { tryCodegenAfterCompile } from "./codegenFirmware";
import { pickProjectLocation, readJsonFile, writeJsonFile } from "./projectPaths";
import { ensureProjectFirmwareTree } from "./scaffoldFirmware";
import { tryBuildFirmwareAfterCompile } from "./projectFirmware";
import {
  flushPendingFbdDocumentEdits,
  saveDirtyFbdDocuments,
} from "../fbdEditor/fbdEditorProvider";

const DIAG_COLLECTION = "nanoplc";
let diagnosticCollection: vscode.DiagnosticCollection | undefined;

function getDiagnosticCollection(): vscode.DiagnosticCollection {
  if (!diagnosticCollection) {
    diagnosticCollection = vscode.languages.createDiagnosticCollection(DIAG_COLLECTION);
  }
  return diagnosticCollection;
}

export function registerCompileProgram(context: vscode.ExtensionContext): vscode.Disposable {
  context.subscriptions.push(getDiagnosticCollection());
  return vscode.commands.registerCommand("nanoplc.compileProgram", () => {
    void compileActiveProject();
  });
}

function diagnosticUri(rootPath: string, relSource: string): vscode.Uri {
  return vscode.Uri.file(path.join(rootPath, relSource));
}

function publishDiagnostics(
  rootPath: string,
  programSource: string,
  diagnostics: CompileDiagnostic[]
): void {
  const collection = getDiagnosticCollection();
  const uri = diagnosticUri(rootPath, programSource);
  collection.set(
    uri,
    diagnostics.map((d) => {
      const severity =
        d.severity === "warning" ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
      const diag = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `[${d.code}] ${d.message}`, severity);
      if (d.block_id) {
        diag.code = d.code;
        diag.source = `block ${d.block_id}`;
      } else {
        diag.code = d.code;
      }
      return diag;
    })
  );
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ProjectFbdGateResult {
  ok: boolean;
  unboundIoBlocks: string[];
  diagnostics: CompileDiagnostic[];
}

function loadFbdRaw(rootPath: string, relSource: string): unknown {
  const abs = path.normalize(path.join(rootPath, relSource));
  const open = vscode.workspace.textDocuments.find(
    (d) => path.normalize(d.uri.fsPath) === abs
  );
  if (open) {
    return JSON.parse(open.getText()) as unknown;
  }
  return readJsonFile<unknown>(abs);
}

/**
 * Validate the project's FBD (including DI/DO channel bindings) without writing IR.
 * Publishes Problems diagnostics. Used by Compile and by Build firmware.
 */
export function gateProjectFbd(rootPath: string, project: NanoPlcProject): ProjectFbdGateResult {
  const program = project.programs[0];
  if (!program) {
    return {
      ok: false,
      unboundIoBlocks: [],
      diagnostics: [{ code: "NP-0105", message: "No program defined in project.", severity: "error" }],
    };
  }

  if (program.language !== "fbd") {
    return {
      ok: false,
      unboundIoBlocks: [],
      diagnostics: [
        {
          code: "NP-0205",
          message: `Compile supports FBD JSON only (${program.language} not yet implemented).`,
          severity: "error",
        },
      ],
    };
  }

  let fbdRaw: unknown;
  try {
    fbdRaw = loadFbdRaw(rootPath, program.source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      unboundIoBlocks: [],
      diagnostics: [{ code: "NP-0200", message: `Cannot read FBD source: ${msg}`, severity: "error" }],
    };
  }

  let ioMap: IoMap | undefined;
  const ioMapPath = path.join(rootPath, "src", "io-map.json");
  if (fs.existsSync(ioMapPath)) {
    try {
      ioMap = readJsonFile<IoMap>(ioMapPath);
    } catch {
      ioMap = undefined;
    }
  }

  const result = compileFbdToIr(project, fbdRaw, program.id, ioMap);
  publishDiagnostics(rootPath, program.source, result.diagnostics);

  return {
    ok: result.ok,
    unboundIoBlocks: result.diagnostics
      .filter((d) => d.code === "NP-0214")
      .map((d) => d.block_id ?? "?"),
    diagnostics: result.diagnostics,
  };
}

export function showFbdGateFailure(gate: ProjectFbdGateResult, action = "compile"): void {
  if (gate.unboundIoBlocks.length > 0) {
    void vscode.window.showErrorMessage(
      `NanoPLC: Assign an I/O channel to every Digital In / Digital Out before ${action} (${gate.unboundIoBlocks.join(", ")}). See Problems.`
    );
    return;
  }
  const first = gate.diagnostics.find((d) => d.severity === "error");
  void vscode.window.showErrorMessage(
    first
      ? `NanoPLC: ${first.message} See Problems.`
      : "NanoPLC: PLC program is invalid. See Problems."
  );
}

export interface CompileProjectOptions {
  /** When false, never start idf.py build. When true, always try. Default: respect setting. */
  buildFirmware?: boolean;
  /** Suppress the success toast (caller shows its own). */
  quietSuccess?: boolean;
}

/** Flush editor buffers, then compile the project at `rootPath`. Returns false on failure. */
export async function compileProjectAt(
  rootPath: string,
  options: CompileProjectOptions = {}
): Promise<boolean> {
  await saveDirtyFbdDocuments(rootPath);

  const projectPath = path.join(rootPath, "nanoplc.project.json");
  let projectRaw: unknown;
  try {
    projectRaw = readJsonFile<unknown>(projectPath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`NanoPLC: Cannot read project file: ${msg}`);
    return false;
  }

  const { project, diagnostics: projectDiags } = validateProject(projectRaw);
  if (!project) {
    publishDiagnostics(rootPath, "nanoplc.project.json", projectDiags);
    void vscode.window.showErrorMessage("NanoPLC: Project validation failed. See Problems.");
    return false;
  }

  const program = project.programs[0];
  if (!program) {
    void vscode.window.showErrorMessage("NanoPLC: No program defined in project.");
    return false;
  }

  if (program.language !== "fbd") {
    void vscode.window.showWarningMessage(
      `NanoPLC: Compile supports FBD JSON only in this release (${program.language} not yet implemented).`
    );
    return false;
  }

  let fbdRaw: unknown;
  try {
    fbdRaw = loadFbdRaw(rootPath, program.source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void vscode.window.showErrorMessage(`NanoPLC: Cannot read FBD source: ${msg}`);
    return false;
  }

  let ioMap: IoMap | undefined;
  const ioMapPath = path.join(rootPath, "src", "io-map.json");
  if (fs.existsSync(ioMapPath)) {
    ioMap = readJsonFile<IoMap>(ioMapPath);
    if (ioMap.schema_version !== IO_MAP_SCHEMA_VERSION) {
      void vscode.window.showWarningMessage(
        `NanoPLC: io-map.json schema_version ${ioMap.schema_version} may not match tooling.`
      );
    }
  }

  const result = compileFbdToIr(project, fbdRaw, program.id, ioMap);
  publishDiagnostics(rootPath, program.source, [...projectDiags, ...result.diagnostics]);

  if (!result.ok || !result.ir) {
    showFbdGateFailure(
      {
        ok: false,
        unboundIoBlocks: result.diagnostics
          .filter((d) => d.code === "NP-0214")
          .map((d) => d.block_id ?? "?"),
        diagnostics: result.diagnostics,
      },
      options.buildFirmware === false ? "build" : "compile"
    );
    return false;
  }

  const buildDir = path.join(rootPath, "build");
  const irPath = path.join(buildDir, "ir.json");
  const irText = JSON.stringify(result.ir, null, 2);
  writeJsonFile(irPath, result.ir);

  const irSha256 = sha256(irText);
  const firmwareTree = ensureProjectFirmwareTree(rootPath, project);
  if (firmwareTree.created) {
    void vscode.window.showInformationMessage(`NanoPLC: ${firmwareTree.message}`);
  }

  const codegenResult = tryCodegenAfterCompile(rootPath, project, result.ir, irSha256);

  let firmwareBuildResult: ReturnType<typeof tryBuildFirmwareAfterCompile> | undefined;
  const shouldBuildFirmware =
    options.buildFirmware === true
      ? true
      : options.buildFirmware === false
        ? false
        : codegenResult.ok;
  if (shouldBuildFirmware && codegenResult.ok) {
    // When buildFirmware is undefined, tryBuildFirmwareAfterCompile still respects the setting.
    firmwareBuildResult = tryBuildFirmwareAfterCompile(rootPath, project);
  }

  const manifest: Record<string, unknown> = {
    ir_version: IR_VERSION,
    ir_sha256: irSha256,
    compiled_at: new Date().toISOString(),
    program_id: program.id,
    program_source: program.source,
    schedule_steps: result.ir.schedule.length,
    codegen_cli_version: "0.1.0",
    device: {
      board: project.device.board,
      idf_target: project.device.idf_target,
      catalog_id: project.device.catalog_id,
      model: project.device.model,
    },
    codegen: {
      ok: codegenResult.ok,
      message: codegenResult.message,
    },
  };

  if (firmwareBuildResult) {
    manifest.firmware = {
      ok: firmwareBuildResult.ok,
      message: firmwareBuildResult.message,
      root: firmwareBuildResult.firmwareRoot,
      idf_target: firmwareBuildResult.idfTarget,
      idf_steps: firmwareBuildResult.idfSteps,
      started_at: new Date().toISOString(),
    };
  }

  writeJsonFile(path.join(buildDir, "generated.manifest.json"), manifest);

  if (!options.quietSuccess) {
    let detail = `Compiled "${program.name}" → build/ir.json (${result.ir.schedule.length} steps).`;
    if (codegenResult.ok && codegenResult.message.startsWith("Generated")) {
      detail += ` ${codegenResult.message}`;
    } else if (!codegenResult.ok) {
      detail += ` Codegen: ${codegenResult.message}`;
    }
    if (firmwareBuildResult?.ok && firmwareBuildResult.message.startsWith("Building")) {
      detail += ` ${firmwareBuildResult.message}`;
    } else if (firmwareBuildResult && !firmwareBuildResult.ok) {
      detail += ` Firmware: ${firmwareBuildResult.message}`;
    }
    void vscode.window.showInformationMessage(`NanoPLC: ${detail}`);
  }

  return true;
}

export async function compileActiveProject(options?: CompileProjectOptions): Promise<boolean> {
  await flushPendingFbdDocumentEdits();
  const location = await pickProjectLocation();
  if (!location) {
    return false;
  }
  return compileProjectAt(location.rootPath, options);
}

export async function scaffoldProject(
  folder: vscode.WorkspaceFolder,
  name: string,
  catalogEntry: DeviceCatalogEntry
): Promise<void> {
  const root = folder.uri.fsPath;
  const projectPath = path.join(root, "nanoplc.project.json");
  if (fs.existsSync(projectPath)) {
    void vscode.window.showErrorMessage("NanoPLC: nanoplc.project.json already exists in this folder.");
    return;
  }

  const project: NanoPlcProject = {
    schema_version: PROJECT_SCHEMA_VERSION,
    name,
    device: buildProjectDeviceFields(catalogEntry),
    scan: { period_ms: catalogEntry.scan_period_ms },
    modules: [{ ...catalogEntry.module }],
    drivers: [{ ...catalogEntry.driver, binds: catalogEntry.module.id }],
    programs: [
      {
        id: "main",
        name: "Main",
        source: "src/main.fbd.json",
        language: "fbd",
      },
    ],
    firmware_root: "firmware",
  };

  const diSymbol = `${catalogEntry.io.di_symbol_prefix}1`;
  const doSymbol = `${catalogEntry.io.do_symbol_prefix}1`;

  const fbd = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: diSymbol } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: doSymbol } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };

  const ioMap = buildIoMapFromCatalog(catalogEntry);

  writeJsonFile(projectPath, project);
  writeJsonFile(path.join(root, "src", "main.fbd.json"), fbd);
  writeJsonFile(path.join(root, "src", "io-map.json"), ioMap);
  fs.mkdirSync(path.join(root, "build"), { recursive: true });

  const firmwareTree = ensureProjectFirmwareTree(root, project);
  if (!firmwareTree.ok) {
    void vscode.window.showWarningMessage(`NanoPLC: ${firmwareTree.message}`);
  }

  void vscode.window.showInformationMessage(
    `NanoPLC: Added ${catalogEntry.model} — ${catalogEntry.io.di_count} DI / ${catalogEntry.io.do_count} DO. Open Application → Programs → Main.`
  );
}

async function pickDeviceCatalogEntry(): Promise<DeviceCatalogEntry | undefined> {
  const picked = await vscode.window.showQuickPick(
    DEVICE_CATALOG.map((entry) => ({
      label: entry.label,
      description: `${entry.io.di_count} DI / ${entry.io.do_count} DO`,
      detail: entry.description,
      entry,
    })),
    {
      placeHolder: "Select PLC device from catalog",
      matchOnDescription: true,
      matchOnDetail: true,
    }
  );
  return picked?.entry;
}

export function registerCreateProject(): vscode.Disposable {
  const runCreate = async (): Promise<void> => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showErrorMessage("NanoPLC: Open a folder before creating a project.");
      return;
    }

    const catalogEntry = await pickDeviceCatalogEntry();
    if (!catalogEntry) {
      return;
    }

    const name = await vscode.window.showInputBox({
      prompt: `Project name (${catalogLabel(catalogEntry)})`,
      value: path.basename(folder.uri.fsPath),
      validateInput: (v) => (v.trim() ? null : "Name is required"),
    });
    if (!name) {
      return;
    }
    await scaffoldProject(folder, name.trim(), catalogEntry);
    await vscode.commands.executeCommand("nanoplc.refreshProjectTree");
  };

  return vscode.Disposable.from(
    vscode.commands.registerCommand("nanoplc.createProject", runCreate),
    vscode.commands.registerCommand("nanoplc.addDevice", runCreate)
  );
}
