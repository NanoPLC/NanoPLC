import * as vscode from "vscode";

import {
  DEFAULT_CYCLIC_INTERVAL_MS,
  DEFAULT_EXTRA_TASK_PRIORITY,
  DEFAULT_WATCHDOG_TIME_MS,
  MAX_TASK_PRIORITY,
  MIN_TASK_PRIORITY,
  ensureProjectTasks,
  findTask,
  setTaskProgram,
  syncScanFromTasks,
  taskEntryProgramId,
  taskKindLabel,
  type NanoPlcProject,
  type NanoPlcTaskRef,
  type PlcTaskKind,
} from "@nanoplc/ir-schema";

import {
  findProjectFileAtRoot,
  pickProjectLocation,
  readJsonFile,
  writeJsonFile,
  type ProjectLocation,
} from "./projectPaths";
import type { NanoPlcTreeItem } from "./projectTree";

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
  syncScanFromTasks(project);
  writeJsonFile(findProjectFileAtRoot(location.rootPath), project);
  void vscode.commands.executeCommand("nanoplc.refreshProjectTree");
}

function nextId(prefix: string, existing: string[]): string {
  let n = 1;
  const set = new Set(existing);
  while (set.has(`${prefix}${n}`)) {
    n++;
  }
  return `${prefix}${n}`;
}

async function promptTaskKind(current?: PlcTaskKind): Promise<PlcTaskKind | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "Cyclic",
        description: "Run every interval (CODESYS Cyclic)",
        taskKind: "cyclic" as const,
      },
      {
        label: "Freewheeling",
        description: "Run again as soon as the previous pass finishes",
        taskKind: "freewheeling" as const,
      },
      {
        label: "Event",
        description: "Rising edge of a DI or BOOL variable",
        taskKind: "event" as const,
      },
    ],
    {
      placeHolder: current ? `Task type (currently ${taskKindLabel(current)})` : "Task type",
      title: "NanoPLC task type",
    }
  );
  if (!picked) {
    return undefined;
  }
  return picked.taskKind;
}

async function promptIntervalMs(current: number): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: "Cyclic interval (milliseconds)",
    value: String(current),
    validateInput: (raw) => {
      const n = Number.parseInt(raw.trim(), 10);
      if (!Number.isInteger(n) || n < 1) {
        return "Enter an integer ≥ 1.";
      }
      return null;
    },
  });
  if (!value) {
    return undefined;
  }
  return Number.parseInt(value.trim(), 10);
}

async function promptPriority(current: number): Promise<number | undefined> {
  const value = await vscode.window.showInputBox({
    prompt: `Priority (${MIN_TASK_PRIORITY} = highest, ${MAX_TASK_PRIORITY} = lowest)`,
    value: String(current),
    validateInput: (raw) => {
      const n = Number.parseInt(raw.trim(), 10);
      if (!Number.isInteger(n) || n < MIN_TASK_PRIORITY || n > MAX_TASK_PRIORITY) {
        return `Enter an integer ${MIN_TASK_PRIORITY}–${MAX_TASK_PRIORITY}.`;
      }
      return null;
    },
  });
  if (!value) {
    return undefined;
  }
  return Number.parseInt(value.trim(), 10);
}

async function promptWatchdog(task: NanoPlcTaskRef): Promise<NanoPlcTaskRef["watchdog"] | undefined> {
  const enable = await vscode.window.showQuickPick(
    [
      { label: "Enabled", enable: true },
      { label: "Disabled", enable: false },
    ],
    { placeHolder: "Task watchdog", title: `Watchdog — ${task.name}` }
  );
  if (!enable) {
    return undefined;
  }
  if (!enable.enable) {
    return { enabled: false, time_ms: task.watchdog?.time_ms ?? DEFAULT_WATCHDOG_TIME_MS };
  }
  const defaultTime =
    task.watchdog?.time_ms ??
    Math.max(DEFAULT_WATCHDOG_TIME_MS, (task.interval_ms ?? DEFAULT_CYCLIC_INTERVAL_MS) * 5);
  const value = await vscode.window.showInputBox({
    prompt: "Watchdog time (milliseconds)",
    value: String(defaultTime),
    validateInput: (raw) => {
      const n = Number.parseInt(raw.trim(), 10);
      if (!Number.isInteger(n) || n < 1) {
        return "Enter an integer ≥ 1.";
      }
      return null;
    },
  });
  if (!value) {
    return undefined;
  }
  const action = await vscode.window.showQuickPick(
    [
      {
        label: "Hold last outputs",
        description: "Log the overrun; DO values stay as they are",
        on_timeout: "hold" as const,
      },
      {
        label: "Force outputs OFF",
        description: "Latch every DO to OFF until reboot",
        on_timeout: "outputs_off" as const,
      },
    ],
    {
      placeHolder: "Watchdog timeout action",
      title: `Watchdog action — ${task.name}`,
    }
  );
  if (!action) {
    return undefined;
  }
  return {
    enabled: true,
    time_ms: Number.parseInt(value.trim(), 10),
    on_timeout: action.on_timeout,
  };
}

async function configureTaskFields(task: NanoPlcTaskRef): Promise<NanoPlcTaskRef | undefined> {
  const name = await vscode.window.showInputBox({
    prompt: "Task name",
    value: task.name,
    validateInput: (v) => (v.trim() ? null : "Name is required"),
  });
  if (!name) {
    return undefined;
  }

  const kind = await promptTaskKind(task.kind);
  if (!kind) {
    return undefined;
  }

  let interval_ms = task.interval_ms;
  let event = task.event;
  if (kind === "cyclic") {
    const interval = await promptIntervalMs(interval_ms && interval_ms > 0 ? interval_ms : DEFAULT_CYCLIC_INTERVAL_MS);
    if (interval === undefined) {
      return undefined;
    }
    interval_ms = interval;
    event = undefined;
  } else if (kind === "event") {
    const ev = await vscode.window.showInputBox({
      prompt: "Event trigger (DI symbol or Program.Var BOOL, rising edge)",
      value: event ?? "",
      placeHolder: "e.g. DI_Start or Main.Pulse",
    });
    if (ev === undefined) {
      return undefined;
    }
    event = ev.trim();
    interval_ms = undefined;
  } else {
    interval_ms = undefined;
    event = undefined;
  }

  const priority = await promptPriority(task.priority);
  if (priority === undefined) {
    return undefined;
  }

  const watchdog = await promptWatchdog({ ...task, kind, interval_ms });
  if (!watchdog) {
    return undefined;
  }

  return {
    ...task,
    name: name.trim(),
    kind,
    interval_ms,
    event: event || undefined,
    priority,
    watchdog,
  };
}

export function registerTaskCommands(context: vscode.ExtensionContext): vscode.Disposable {
  const disposables = [
    vscode.commands.registerCommand("nanoplc.addTask", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location) {
        return;
      }
      const project = loadProject(location);
      const tasks = ensureProjectTasks(project);
      const id = nextId(
        "task",
        tasks.map((t) => t.id)
      );
      const draft: NanoPlcTaskRef = {
        id,
        name: `Task${tasks.length}`,
        kind: "cyclic",
        priority: DEFAULT_EXTRA_TASK_PRIORITY,
        interval_ms: 20,
        watchdog: { enabled: true, time_ms: 100 },
      };
      const configured = await configureTaskFields(draft);
      if (!configured) {
        return;
      }
      tasks.push(configured);
      saveProject(location, project);
      void vscode.window.showInformationMessage(
        `NanoPLC: Added task "${configured.name}" (${taskKindLabel(configured.kind)}).`
      );
    }),

    vscode.commands.registerCommand("nanoplc.configureTask", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location || !item?.refId) {
        return;
      }
      const project = loadProject(location);
      const tasks = ensureProjectTasks(project);
      const task = tasks.find((t) => t.id === item.refId);
      if (!task) {
        return;
      }
      const configured = await configureTaskFields(task);
      if (!configured) {
        return;
      }
      const index = tasks.findIndex((t) => t.id === task.id);
      tasks[index] = configured;
      saveProject(location, project);
    }),

    vscode.commands.registerCommand("nanoplc.deleteTask", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location || !item?.refId) {
        return;
      }
      const project = loadProject(location);
      const tasks = ensureProjectTasks(project);
      if (tasks.length <= 1) {
        void vscode.window.showWarningMessage("NanoPLC: The project must keep at least one task.");
        return;
      }
      const task = findTask(project, item.refId);
      if (!task) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete task "${task.name}"? Assigned programs are not deleted.`,
        { modal: true },
        "Delete"
      );
      if (confirm !== "Delete") {
        return;
      }
      project.tasks = tasks.filter((t) => t.id !== task.id);
      saveProject(location, project);
    }),

    vscode.commands.registerCommand("nanoplc.addProgramToTask", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location || !item?.refId) {
        return;
      }
      const project = loadProject(location);
      const tasks = ensureProjectTasks(project);
      const task = tasks.find((t) => t.id === item.refId);
      if (!task) {
        return;
      }
      const current = taskEntryProgramId(task);
      const available = project.programs.filter((p) => p.id !== current);
      if (available.length === 0) {
        void vscode.window.showInformationMessage(
          current
            ? "NanoPLC: This task already runs the only program in the project. Add another program, then give it its own task."
            : "NanoPLC: Add a program under Application → Programs first."
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        available.map((p) => ({
          label: p.name,
          description: p.id,
          detail: `${p.language.toUpperCase()} · ${p.source}`,
          program: p,
        })),
        {
          placeHolder: current
            ? `Replace program on ${task.name}`
            : `Run program from ${task.name}`,
        }
      );
      if (!picked) {
        return;
      }
      if (current && current !== picked.program.id) {
        const ok = await vscode.window.showWarningMessage(
          `Task "${task.name}" already runs a program. Replace it? Extra programs need their own task, or a CALL from another program.`,
          { modal: true },
          "Replace"
        );
        if (ok !== "Replace") {
          return;
        }
      }
      setTaskProgram(task, picked.program.id);
      saveProject(location, project);
    }),

    vscode.commands.registerCommand("nanoplc.removeProgramFromTask", async (item?: NanoPlcTreeItem) => {
      const location = await resolveLocation(item);
      if (!location || !item?.refId) {
        return;
      }
      const project = loadProject(location);
      const tasks = ensureProjectTasks(project);
      const task = tasks.find((t) => t.id === item.refId);
      if (!task) {
        return;
      }
      setTaskProgram(task, undefined);
      saveProject(location, project);
    }),
  ];

  context.subscriptions.push(...disposables);
  return vscode.Disposable.from(...disposables);
}
