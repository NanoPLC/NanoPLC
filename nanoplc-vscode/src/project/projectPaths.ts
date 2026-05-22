import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export const PROJECT_FILENAME = "nanoplc.project.json";

export interface ProjectLocation {
  /** Directory containing nanoplc.project.json */
  rootPath: string;
  /** Nearest VS Code workspace folder that encloses rootPath */
  workspaceFolder: vscode.WorkspaceFolder;
  /** Display label (relative path or folder name) */
  label: string;
}

function findProjectsUnder(dir: string, workspaceFolder: vscode.WorkspaceFolder, out: ProjectLocation[]): void {
  const direct = path.join(dir, PROJECT_FILENAME);
  if (fs.existsSync(direct)) {
    const rel = path.relative(workspaceFolder.uri.fsPath, dir);
    out.push({
      rootPath: dir,
      workspaceFolder,
      label: rel === "" ? workspaceFolder.name : rel.replace(/\\/g, "/"),
    });
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) {
      continue;
    }
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name === "firmware") {
      continue;
    }
    findProjectsUnder(path.join(dir, ent.name), workspaceFolder, out);
  }
}

export function discoverProjects(): ProjectLocation[] {
  const out: ProjectLocation[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    findProjectsUnder(folder.uri.fsPath, folder, out);
  }
  return out;
}

export function findProjectFileAtRoot(rootPath: string): string {
  return path.join(rootPath, PROJECT_FILENAME);
}

export async function pickProjectLocation(): Promise<ProjectLocation | undefined> {
  const projects = discoverProjects();
  if (projects.length === 0) {
    void vscode.window.showErrorMessage(
      `NanoPLC: No ${PROJECT_FILENAME} found in the workspace. Run "NanoPLC: Create project" first.`
    );
    return undefined;
  }
  if (projects.length === 1) {
    return projects[0];
  }
  const picked = await vscode.window.showQuickPick(
    projects.map((p) => ({ label: p.label, description: p.rootPath, project: p })),
    { placeHolder: "Select NanoPLC project" }
  );
  return picked?.project;
}

export function readJsonFile<T>(absPath: string): T {
  const text = fs.readFileSync(absPath, "utf8");
  return JSON.parse(text) as T;
}

export function writeJsonFile(absPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
