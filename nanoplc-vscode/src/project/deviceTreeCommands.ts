import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  defaultProjectDrivers,
  defaultProjectModules,
  FBD_SOURCE_SCHEMA_VERSION,
  IO_MAP_SCHEMA_VERSION,
  resolveDeviceTree,
  type NanoPlcDriverRef,
  type NanoPlcModuleRef,
  type NanoPlcProgramRef,
  type NanoPlcProject,
} from "@nanoplc/ir-schema";

import {
  findProjectFileAtRoot,
  pickProjectLocation,
  readJsonFile,
  writeJsonFile,
  type ProjectLocation,
} from "./projectPaths";
import type { NanoPlcTreeItem } from "./projectTree";

let refreshTree: (() => void) | undefined;

export function bindTreeRefresh(refresh: () => void): void {
  refreshTree = refresh;
}

async function resolveLocation(item?: NanoPlcTreeItem): Promise<ProjectLocation | undefined> {
  if (item?.location) {
    return item.location;
  }
  return pickProjectLocation();
}

function loadProject(location: ProjectLocation): NanoPlcProject {
  return readJsonFile<NanoPlcProject>(findProjectFileAtRoot(location.rootPath));
}

function saveProject(location: ProjectLocation, project: NanoPlcProject): void {
  writeJsonFile(findProjectFileAtRoot(location.rootPath), project);
}

function nextId(prefix: string, existing: string[]): string {
  let n = 1;
  const set = new Set(existing);
  while (set.has(`${prefix}${n}`)) {
    n++;
  }
  return `${prefix}${n}`;
}

function scaffoldIoMap(rootPath: string): void {
  const ioMapPath = path.join(rootPath, "src", "io-map.json");
  if (fs.existsSync(ioMapPath)) {
    return;
  }
  writeJsonFile(ioMapPath, {
    schema_version: IO_MAP_SCHEMA_VERSION,
    entries: [
      { symbol: "DI_Start", kind: "DI", index: 0, gpio: 0, active_high: true },
      { symbol: "DO_Lamp", kind: "DO", index: 0, gpio: 2, active_high: true },
    ],
  });
}

export function registerDeviceTreeCommands(context: vscode.ExtensionContext): vscode.Disposable {
  const disposables = [
    vscode.commands.registerCommand("nanoplc.addModule", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location) {
        return;
      }
      const project = loadProject(location);
      project.modules = project.modules ?? [...defaultProjectModules()];

      const name = await vscode.window.showInputBox({
        prompt: "Module name",
        value: "Digital I/O module",
        validateInput: (v) => (v.trim() ? null : "Name is required"),
      });
      if (!name) {
        return;
      }

      const id = nextId(
        "mod",
        project.modules.map((m) => m.id)
      );
      const mod: NanoPlcModuleRef = {
        id,
        name: name.trim(),
        type: "gpio_digital_io",
        config: "src/io-map.json",
      };
      project.modules.push(mod);
      scaffoldIoMap(location.rootPath);
      saveProject(location, project);
      refreshTree?.();
      void vscode.window.showInformationMessage(`NanoPLC: Added module "${mod.name}".`);
    }),

    vscode.commands.registerCommand("nanoplc.addDriver", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location) {
        return;
      }
      const project = loadProject(location);
      const { modules } = resolveDeviceTree(project);
      if (modules.length === 0) {
        void vscode.window.showWarningMessage("NanoPLC: Add an I/O module before adding a driver.");
        return;
      }

      project.drivers = project.drivers ?? [...defaultProjectDrivers()];

      const modulePick = await vscode.window.showQuickPick(
        modules.map((m) => ({ label: m.name, description: m.id, module: m })),
        { placeHolder: "Select module to bind" }
      );
      if (!modulePick) {
        return;
      }

      const id = nextId(
        "drv",
        project.drivers.map((d) => d.id)
      );
      const drv: NanoPlcDriverRef = {
        id,
        name: "GPIO process image (nanoplc_hal)",
        type: "nanoplc_hal",
        binds: modulePick.module.id,
      };
      project.drivers.push(drv);
      saveProject(location, project);
      refreshTree?.();
      void vscode.window.showInformationMessage(`NanoPLC: Added driver bound to "${modulePick.label}".`);
    }),

    vscode.commands.registerCommand("nanoplc.addProgram", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location) {
        return;
      }
      const project = loadProject(location);

      const name = await vscode.window.showInputBox({
        prompt: "Program (POU) name",
        value: "Main",
        validateInput: (v) => (v.trim() ? null : "Name is required"),
      });
      if (!name) {
        return;
      }

      const language = await vscode.window.showQuickPick(
        [
          { label: "FBD (Function Block Diagram)", value: "fbd" as const },
          { label: "ST (Structured Text)", value: "st" as const, description: "Text editor only" },
        ],
        { placeHolder: "Program language" }
      );
      if (!language) {
        return;
      }

      const id = nextId(
        "prog",
        project.programs.map((p) => p.id)
      );
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const ext = language.value === "fbd" ? "fbd.json" : language.value === "st" ? "st" : "lad";
      const source = `src/${slug}.${ext}`;

      const program: NanoPlcProgramRef = {
        id,
        name: name.trim(),
        source,
        language: language.value,
      };

      const absSource = path.join(location.rootPath, source);
      if (!fs.existsSync(absSource)) {
        fs.mkdirSync(path.dirname(absSource), { recursive: true });
        if (language.value === "fbd") {
          writeJsonFile(absSource, {
            schema_version: FBD_SOURCE_SCHEMA_VERSION,
            name: program.name,
            blocks: [],
            wires: [],
          });
        } else {
          fs.writeFileSync(absSource, `(* ${program.name} *)\n\n`, "utf8");
        }
      }

      project.programs.push(program);
      saveProject(location, project);
      refreshTree?.();

      const uri = vscode.Uri.file(absSource);
      if (language.value === "fbd") {
        await vscode.commands.executeCommand("vscode.openWith", uri, "nanoplc.fbdEditor");
      } else {
        await vscode.commands.executeCommand("vscode.open", uri);
      }
    }),

    vscode.commands.registerCommand(
      "nanoplc.showDriverInfo",
      async (location: ProjectLocation, driverId?: string) => {
        if (!location || !driverId) {
          return;
        }
        const project = loadProject(location);
        const { drivers, modules } = resolveDeviceTree(project);
        const drv = drivers.find((d) => d.id === driverId);
        if (!drv) {
          return;
        }
        const mod = modules.find((m) => m.id === drv.binds);
        const detail =
          `Driver: ${drv.name}\n` +
          `Type: ${drv.type}\n` +
          (mod ? `Binds to module: ${mod.name} (${mod.id})\n` : "") +
          (mod?.config ? `Module config: ${mod.config}\n` : "") +
          `\nFirmware component: firmware/components/nanoplc_hal/`;

        await vscode.window.showInformationMessage("NanoPLC Driver", { modal: true, detail });
      }
    ),
  ];

  context.subscriptions.push(...disposables);
  return vscode.Disposable.from(...disposables);
}
