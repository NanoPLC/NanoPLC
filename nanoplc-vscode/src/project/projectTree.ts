import * as path from "path";
import * as vscode from "vscode";

import {
  resolveDeviceTree,
  type NanoPlcDriverRef,
  type NanoPlcModuleRef,
  type NanoPlcProgramRef,
  type NanoPlcProject,
} from "@nanoplc/ir-schema";

import { discoverProjects, findProjectFileAtRoot, readJsonFile, type ProjectLocation } from "./projectPaths";
import { bindTreeRefresh } from "./deviceTreeCommands";

const FBD_EDITOR_VIEW = "nanoplc.fbdEditor";

export type NanoPlcTreeKind =
  | "empty_hint"
  | "device"
  | "device_config"
  | "modules_group"
  | "module"
  | "drivers_group"
  | "driver"
  | "communication_group"
  | "communication_placeholder"
  | "application_group"
  | "programs_group"
  | "program"
  | "firmware";

export class NanoPlcTreeItem extends vscode.TreeItem {
  constructor(
    public readonly kind: NanoPlcTreeKind,
    label: string,
    collapsible: vscode.TreeItemCollapsibleState,
    public readonly location: ProjectLocation | undefined,
    public readonly relPath?: string,
    public readonly refId?: string
  ) {
    super(label, collapsible);
    this.contextValue = kind;

    if (!location) {
      if (kind === "empty_hint") {
        this.iconPath = new vscode.ThemeIcon("info");
        this.command = {
          command: "nanoplc.createProject",
          title: "Add device",
        };
      }
      return;
    }

    const root = location.rootPath;
    this.tooltip = relPath ? path.join(root, relPath) : label;

    switch (kind) {
      case "device":
        this.iconPath = new vscode.ThemeIcon("circuit-board");
        break;
      case "device_config":
        this.iconPath = new vscode.ThemeIcon("settings-gear");
        this.resourceUri = vscode.Uri.file(findProjectFileAtRoot(root));
        this.command = openFileCommand(this.resourceUri);
        this.description = "scan, board, target";
        break;
      case "modules_group":
        this.iconPath = new vscode.ThemeIcon("symbol-module");
        break;
      case "module":
        this.iconPath = new vscode.ThemeIcon("plug");
        if (relPath) {
          this.resourceUri = vscode.Uri.file(path.join(root, relPath));
          this.command = openFileCommand(this.resourceUri);
        }
        break;
      case "drivers_group":
        this.iconPath = new vscode.ThemeIcon("server-environment");
        break;
      case "driver":
        this.iconPath = new vscode.ThemeIcon("server-process");
        this.command = {
          command: "nanoplc.showDriverInfo",
          title: "Driver info",
          arguments: [location, refId],
        };
        break;
      case "communication_group":
        this.iconPath = new vscode.ThemeIcon("globe");
        break;
      case "communication_placeholder":
        this.iconPath = new vscode.ThemeIcon("circle-slash");
        break;
      case "application_group":
        this.iconPath = new vscode.ThemeIcon("layers");
        break;
      case "programs_group":
        this.iconPath = new vscode.ThemeIcon("folder");
        break;
      case "program":
        this.iconPath = new vscode.ThemeIcon("symbol-method");
        if (relPath) {
          this.resourceUri = vscode.Uri.file(path.join(root, relPath));
          this.command = openProgramCommand(this.resourceUri, label);
        }
        break;
      case "firmware":
        this.iconPath = new vscode.ThemeIcon("chip");
        this.resourceUri = vscode.Uri.file(path.join(root, relPath ?? "firmware"));
        break;
    }
  }
}

function openFileCommand(uri: vscode.Uri): vscode.Command {
  return { command: "vscode.open", title: "Open", arguments: [uri] };
}

function openProgramCommand(uri: vscode.Uri, label: string): vscode.Command {
  if (uri.fsPath.endsWith(".fbd.json")) {
    return {
      command: "vscode.openWith",
      title: "Open FBD",
      arguments: [uri, FBD_EDITOR_VIEW],
    };
  }
  return openFileCommand(uri);
}

function readProject(rootPath: string): NanoPlcProject | undefined {
  try {
    return readJsonFile<NanoPlcProject>(findProjectFileAtRoot(rootPath));
  } catch {
    return undefined;
  }
}

function deviceLabel(project: NanoPlcProject): string {
  const hw = project.device.model ?? project.device.board;
  return `${project.name} (${hw})`;
}

export class NanoPlcProjectTreeProvider implements vscode.TreeDataProvider<NanoPlcTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(element: NanoPlcTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: NanoPlcTreeItem): NanoPlcTreeItem[] {
    if (!element) {
      const projects = discoverProjects();
      if (projects.length === 0) {
        return [
          new NanoPlcTreeItem(
            "empty_hint",
            "No device — click to add",
            vscode.TreeItemCollapsibleState.None,
            undefined
          ),
        ];
      }
      return projects.map((location) => {
        let label = location.label;
        const project = readProject(location.rootPath);
        if (project) {
          label = deviceLabel(project);
        }
        return new NanoPlcTreeItem(
          "device",
          label,
          vscode.TreeItemCollapsibleState.Expanded,
          location
        );
      });
    }

    const { location } = element;
    if (!location) {
      return [];
    }

    const { rootPath } = location;
    const project = readProject(rootPath);
    if (!project) {
      return [];
    }

    const tree = resolveDeviceTree(project);

    switch (element.kind) {
      case "device":
        return [
          new NanoPlcTreeItem(
            "device_config",
            "Device configuration",
            vscode.TreeItemCollapsibleState.None,
            location
          ),
          new NanoPlcTreeItem(
            "modules_group",
            "Modules",
            vscode.TreeItemCollapsibleState.Expanded,
            location
          ),
          new NanoPlcTreeItem(
            "drivers_group",
            "Drivers",
            vscode.TreeItemCollapsibleState.Expanded,
            location
          ),
          new NanoPlcTreeItem(
            "communication_group",
            "Communication",
            vscode.TreeItemCollapsibleState.Collapsed,
            location
          ),
          new NanoPlcTreeItem(
            "application_group",
            "Application",
            vscode.TreeItemCollapsibleState.Expanded,
            location
          ),
          new NanoPlcTreeItem(
            "firmware",
            "Firmware (ESP-IDF)",
            vscode.TreeItemCollapsibleState.None,
            location,
            project.firmware_root ?? "firmware"
          ),
        ];

      case "modules_group":
        return tree.modules.map((mod) => moduleItem(location, mod));

      case "drivers_group":
        return tree.drivers.map((drv) => driverItem(location, drv));

      case "communication_group":
        return [
          new NanoPlcTreeItem(
            "communication_placeholder",
            "No protocols configured",
            vscode.TreeItemCollapsibleState.None,
            location
          ),
        ];

      case "application_group":
        return [
          new NanoPlcTreeItem(
            "programs_group",
            "Programs",
            vscode.TreeItemCollapsibleState.Expanded,
            location
          ),
        ];

      case "programs_group":
        return project.programs.map((prog) => programItem(location, prog));

      default:
        return [];
    }
  }
}

function moduleItem(location: ProjectLocation, mod: NanoPlcModuleRef): NanoPlcTreeItem {
  const item = new NanoPlcTreeItem(
    "module",
    mod.name,
    vscode.TreeItemCollapsibleState.None,
    location,
    mod.config,
    mod.id
  );
  item.description = mod.type === "gpio_digital_io" ? "GPIO" : mod.type;
  return item;
}

function driverItem(location: ProjectLocation, drv: NanoPlcDriverRef): NanoPlcTreeItem {
  const item = new NanoPlcTreeItem(
    "driver",
    drv.name,
    vscode.TreeItemCollapsibleState.None,
    location,
    undefined,
    drv.id
  );
  item.description = drv.type;
  return item;
}

function programItem(location: ProjectLocation, prog: NanoPlcProgramRef): NanoPlcTreeItem {
  const lang = prog.language.toUpperCase();
  return new NanoPlcTreeItem(
    "program",
    `${prog.name} (${lang})`,
    vscode.TreeItemCollapsibleState.None,
    location,
    prog.source,
    prog.id
  );
}

export function registerProjectTree(context: vscode.ExtensionContext): vscode.Disposable {
  const provider = new NanoPlcProjectTreeProvider();
  const tree = vscode.window.createTreeView("nanoplcProject", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });

  const refresh = vscode.commands.registerCommand("nanoplc.refreshProjectTree", () => {
    provider.refresh();
  });

  bindTreeRefresh(() => provider.refresh());

  context.subscriptions.push(tree, refresh);
  return vscode.Disposable.from(tree, refresh);
}
