import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

import {
  buildModuleAndDriverRefs,
  buildModuleConfig,
  defaultProjectDrivers,
  defaultProjectModules,
  ensureProjectTasks,
  FBD_SOURCE_SCHEMA_VERSION,
  ioMapIndexOffsets,
  IO_MAP_SCHEMA_VERSION,
  listCompatibleModules,
  moduleCatalogLabel,
  M5STACK_STAMPLC_IO,
  M5STACK_STAMPLC_AC,
  nextStamPlcIoModuleId,
  nextStamPlcAcModuleId,
  parseModuleConfig,
  resolveDeviceTree,
  setTaskProgram,
  syncScanFromTasks,
  taskEntryProgramId,
  type ModuleCatalogEntry,
  type NanoPlcDriverRef,
  type NanoPlcModuleRef,
  type NanoPlcProgramRef,
  type NanoPlcProject,
} from "@nanoplc/ir-schema";

import { loadProjectIoProfile } from "./projectIoLoader";

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
  if (project.tasks && project.tasks.length > 0) {
    syncScanFromTasks(project);
  }
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

function collectExistingIoEntries(rootPath: string, project: NanoPlcProject) {
  const profile = loadProjectIoProfile(rootPath, project);
  return profile.ioMap.entries;
}

function readUsedI2cAddresses(rootPath: string, project: NanoPlcProject): Set<number> {
  const used = new Set<number>();
  const { modules } = resolveDeviceTree(project);
  for (const mod of modules) {
    if (!mod.config) {
      continue;
    }
    const abs = path.join(rootPath, mod.config);
    if (!fs.existsSync(abs)) {
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
      const config = parseModuleConfig(raw);
      if (config?.i2c_address !== undefined) {
        used.add(config.i2c_address);
      }
    } catch {
      // Ignore invalid module config.
    }
  }
  return used;
}

async function pickCatalogModule(
  hostCatalogId?: string
): Promise<ModuleCatalogEntry | "custom" | undefined> {
  const compatible = listCompatibleModules(hostCatalogId);
  const items = [
    ...compatible.map((entry) => ({
      label: moduleCatalogLabel(entry),
      description: entry.model,
      detail: entry.description,
      entry,
    })),
    {
      label: "Custom digital I/O module",
      description: "Manual GPIO module",
      detail: "Generic module with src/io-map.json and nanoplc_hal driver.",
      entry: undefined as ModuleCatalogEntry | undefined,
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: "Select I/O expansion module",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return undefined;
  }
  return picked.entry ?? "custom";
}

async function promptI2cAddress(used: Set<number>, defaultAddr: number): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: "I2C address (hex, StamPLC IO DIP switch: 0x20–0x2F)",
    value: `0x${defaultAddr.toString(16).toUpperCase().padStart(2, "0")}`,
    validateInput: (raw) => {
      const trimmed = raw.trim();
      const n = trimmed.startsWith("0x") ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
      if (!Number.isFinite(n) || n < 0x20 || n > 0x2f) {
        return "Enter an address between 0x20 and 0x2F (DIP switch range).";
      }
      if (used.has(n)) {
        return `Address 0x${n.toString(16).toUpperCase()} is already used by another module.`;
      }
      return null;
    },
  });
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("0x") ? Number.parseInt(trimmed.slice(2), 16) : Number.parseInt(trimmed, 10);
}

function addCatalogModule(
  location: ProjectLocation,
  project: NanoPlcProject,
  entry: ModuleCatalogEntry,
  i2cAddress?: number
): void {
  const existingEntries = collectExistingIoEntries(location.rootPath, project);
  const offsets = ioMapIndexOffsets(existingEntries);
  const moduleId =
    entry.id === M5STACK_STAMPLC_IO.id
      ? nextStamPlcIoModuleId(project.modules!.map((m) => m.id))
      : entry.id === M5STACK_STAMPLC_AC.id
        ? nextStamPlcAcModuleId(project.modules!.map((m) => m.id))
        : nextId(
            "mod",
            project.modules!.map((m) => m.id)
          );
  const instanceNumber =
    entry.id === M5STACK_STAMPLC_IO.id
      ? Number(moduleId.replace(/^stamplc_io_exp/, "")) || 1
      : entry.id === M5STACK_STAMPLC_AC.id
        ? Number(moduleId.replace(/^stamplc_ac_exp/, "")) || 1
        : project.modules!.filter((m) => m.type === entry.module.type).length + 1;

  const moduleConfig = buildModuleConfig(entry, offsets);
  if (i2cAddress !== undefined) {
    moduleConfig.i2c_address = i2cAddress;
  }

  const { module, driver } = buildModuleAndDriverRefs(entry, moduleId, instanceNumber);
  const configPath = path.join(location.rootPath, module.config!);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  writeJsonFile(configPath, moduleConfig);

  project.modules!.push(module);
  project.drivers = project.drivers ?? [...defaultProjectDrivers()];
  project.drivers.push(driver);
  saveProject(location, project);
  refreshTree?.();

  const channelRange =
    entry.io.do_count > 0
      ? `${offsets.do + 1}–${offsets.do + entry.io.do_count}`
      : entry.io.di_count > 0
        ? `${offsets.di + 1}–${offsets.di + entry.io.di_count}`
        : "";
  const ioSummary =
    entry.io.di_count > 0 && entry.io.do_count > 0
      ? `${entry.io.di_count} DI / ${entry.io.do_count} DO`
      : entry.io.do_count > 0
        ? `${entry.io.do_count} DO`
        : `${entry.io.di_count} DI`;
  void vscode.window.showInformationMessage(
    `NanoPLC: Added ${module.name} — ${ioSummary}${channelRange ? ` (channels ${channelRange})` : ""}.`
  );
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

      const hostCatalogId = project.device?.catalog_id;
      const picked = await pickCatalogModule(hostCatalogId);
      if (!picked) {
        return;
      }

      if (picked !== "custom") {
        if (!listCompatibleModules(hostCatalogId).some((m) => m.id === picked.id)) {
          void vscode.window.showWarningMessage(
            `NanoPLC: ${picked.label} is not compatible with this host device.`
          );
          return;
        }

        let i2cAddress: number | undefined;
        if (picked.id === M5STACK_STAMPLC_IO.id) {
          const used = readUsedI2cAddresses(location.rootPath, project);
          const defaultAddr = (picked.default_config?.i2c_address as number | undefined) ?? 0x20;
          let candidate = defaultAddr;
          while (used.has(candidate) && candidate < 0x2f) {
            candidate++;
          }
          const addr = await promptI2cAddress(used, candidate);
          if (addr === undefined) {
            return;
          }
          i2cAddress = addr;
        } else if (picked.id === M5STACK_STAMPLC_AC.id) {
          const used = readUsedI2cAddresses(location.rootPath, project);
          const addr = (picked.default_config?.i2c_address as number | undefined) ?? 0x44;
          if (used.has(addr)) {
            void vscode.window.showWarningMessage(
              `NanoPLC: I2C address 0x${addr.toString(16).toUpperCase()} is already used. StamPLC AC is fixed at 0x44 (one module per host).`
            );
            return;
          }
          i2cAddress = addr;
        }

        addCatalogModule(location, project, picked, i2cAddress);
        return;
      }

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

      const tasks = ensureProjectTasks(project);
      if (item?.kind === "task" && item.refId) {
        const task = tasks.find((t) => t.id === item.refId);
        if (task) {
          setTaskProgram(task, program.id);
        }
      } else if (tasks.length === 1 && !taskEntryProgramId(tasks[0])) {
        setTaskProgram(tasks[0], program.id);
      } else if (tasks.length >= 1) {
        const picked = await vscode.window.showQuickPick(
          [
            ...tasks.map((t) => {
              const current = taskEntryProgramId(t);
              return {
                label: t.name,
                description: current ? `currently ${current}` : t.id,
                task: t,
              };
            }),
            { label: "Do not run from a task", description: "POU only — drop it from the FBD Programs palette to CALL it", task: undefined },
          ],
          { placeHolder: `Run "${program.name}" from which task?` }
        );
        if (picked?.task) {
          const existing = taskEntryProgramId(picked.task);
          if (existing && existing !== program.id) {
            const ok = await vscode.window.showWarningMessage(
              `Task "${picked.task.name}" already runs another program. Replace it? Extra programs need their own task, or a CALL from another program.`,
              { modal: true },
              "Replace"
            );
            if (ok === "Replace") {
              setTaskProgram(picked.task, program.id);
            }
          } else {
            setTaskProgram(picked.task, program.id);
          }
        }
      }

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
        const fwComponent =
          drv.type === "m5_stamplc_io"
            ? "firmware/components/m5_stamplc_io/"
            : drv.type === "m5_stamplc_ac"
              ? "firmware/components/m5_stamplc_ac/"
              : drv.type === "m5_aw9523"
                ? "firmware/components/m5_aw9523/"
                : "firmware/components/nanoplc_hal/";
        const detail =
          `Driver: ${drv.name}\n` +
          `Type: ${drv.type}\n` +
          (mod ? `Binds to module: ${mod.name} (${mod.id})\n` : "") +
          (mod?.config ? `Module config: ${mod.config}\n` : "") +
          `\nFirmware component: ${fwComponent}`;

        await vscode.window.showInformationMessage("NanoPLC Driver", { modal: true, detail });
      }
    ),
  ];

  context.subscriptions.push(...disposables);
  return vscode.Disposable.from(...disposables);
}
