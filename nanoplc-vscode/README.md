# NanoPLC VS Code extension

IEC 61131-3 oriented language support (ST, LAD, FBD) and helpers for NanoPLC tooling. This package is intended to grow into a small PLC IDE: simulation, project tree, ESP-IDF build integration (see repo-level `docs/` in the nanoplc workspace).

## Features

| Area | Details |
|------|---------|
| **Languages** | Syntax highlighting for **Structured Text** (`.st`, `.iecst`), **Ladder** (`.lad`, `.ld`), **FBD** (`.fbd`) |
| **Toolchain** | Bootstrap **ESP-IDF** into your user profile (`~/.nanoplc` or `%USERPROFILE%\.nanoplc`), check `idf.py`, and **Build / Flash / Monitor** under `firmware/` |
| **Project** | `nanoplc.project.json`, **Device** tree (including **Task configuration**), FBD JSON → IR compile, `examples/and_gate`. FBD programs declare IN / IN_OUT / OUT / VAR / TEMP; CALL boxes show the interface ports |

## Commands

Open the Command Palette (**Ctrl+Shift+P** / **Cmd+Shift+P**) and run:

| Command | Purpose |
|---------|---------|
| **NanoPLC: Setup ESP-IDF toolchain (clone + install)** | Clones tagged [esp-idf](https://github.com/espressif/esp-idf) (shallow) and runs `install.bat` / `install.sh` for the configured target—needs Git, disk space, and network |
| **NanoPLC: Check idf.py in PATH** | Runs `idf.py --version`—use after `export.ps1` / `export.sh` in the same terminal, or integrate into your workflow |
| **NanoPLC: Build firmware (idf.py build)** | Sources ESP-IDF export script, `cd` to `nanoplc.firmwareRoot`, runs `idf.py build` in a dedicated terminal |
| **NanoPLC: Flash firmware (idf.py flash)** | Same environment activation, then `idf.py flash` |
| **NanoPLC: Serial monitor (idf.py monitor)** | Opens `idf.py monitor` (Ctrl+] to exit) |
| **NanoPLC: Flash and monitor** | `idf.py flash monitor` in one step |
| **NanoPLC: Set ESP-IDF target** | Runs `idf.py set-target` using `nanoplc-idf.buildTarget` (once per fresh `firmware/` tree) |
| **NanoPLC: Diagnose firmware build environment** | Logs firmware path, export script, and `idf.py --version` to the output panel |
| **NanoPLC: Add device** | Scaffolds `nanoplc.project.json`, MainTask, `src/main.fbd.json`, and `build/` |
| **NanoPLC: Add program (POU)** | Creates an FBD/ST program under Application → Programs. Other FBD programs then appear in the FBD **Programs** palette as `CALL` blocks |
| **NanoPLC: Add task** | Adds a CODESYS-style task (cyclic / freewheeling / event) under Task configuration |
| **NanoPLC: Assign program to task** | Binds one PROGRAM as that task’s entry (replace, not a list) |
| **NanoPLC: Compile PLC program** | Compiles FBD JSON to `build/ir.json` (see `docs/IR_SCHEMA.md`) |
| **NanoPLC: Run simulation** | Executes compiled IR on a scan timer; **Simulator** panel to add module/channel I/O and program variables |
| **NanoPLC: Stop simulation** | Stops the virtual PLC scan loop |
| **NanoPLC: Generate firmware C from IR** | Writes `plc_program.c` from existing `build/ir.json` |
| **NanoPLC: Refresh project tree** | Reloads the **Device** sidebar |
| **NanoPLC: Target platform info** | Shows the current **nanoplc.targetChip** setting (placeholder UI until deeper build wiring) |

## Simulator

After **Compile PLC program**, run **NanoPLC: Run simulation**. The **NanoPLC Simulator** panel starts empty: add digital/analog I/O by **module and channel** (same picker as FBD DI/DO/AI blocks) and add **IN / IN_OUT / OUT / VAR / TEMP** from FBD programs. Toggle or edit values each scan (default 10 ms; UI refresh capped by `nanoplc.simulatorRefreshMs`). Watches are kept per project.

The same panel has a **Virtual plant**: pushbutton, switch, lamp, transmitter (temperature, pressure, or ADC volts), motor, valve, tank, and conveyor. Devices are saved on `nanoplc.project.json` as `virtual_plant` and shown in the Project tree. A device that writes a DI or AI owns that channel (the watch row becomes read-only). The plant runs only in the simulator; **Compile** does not emit it into firmware.

**Run simulation** also listens on localhost for **Modbus TCP** (default port 5502), **MQTT** (5883), and **OPC UA** (54840) so a SCADA client can read and write the process image. The map is `docs/FIELDBUS.md` in the monorepo. Turn a protocol off with `communication` in `nanoplc.project.json` or `nanoplc.fieldbus.enabled`.

Each watch row has **Force** / **Unforce**. A forced value is written back after the virtual plant and after every task pass, so the program cannot clear it. **Unforce** releases it. Watchdog `outputs_off` still turns every DO off.

Runtime lives in `@nanoplc/ir-schema` (`PlcSimulator`) so golden tests can share the same semantics as the IDE.

## Codegen

**Compile PLC program** also writes `firmware/components/nanoplc_generated/plc_program.c` when `nanoplc.codegenOnCompile` is true (default). Or run **NanoPLC: Generate firmware C from IR** manually.

## Settings

Open **Settings** and filter by **NanoPLC**.

**NanoPLC**

- **`nanoplc.targetChip`** — MCU preset (`esp32-s3` default among enum values).
- **`nanoplc.firmwareRoot`** — Relative path from the workspace root to the ESP-IDF app (default `firmware`).
- **`nanoplc.codegenOnCompile`** — Emit `plc_program.c` into firmware after compile (default `true`).
- **`nanoplc.simulatorRefreshMs`** — Simulator panel refresh interval (default `50`).

**NanoPLC ESP-IDF**

- **`nanoplc-idf.distRoot`** — Root for the toolchain checkout (leave empty for default `~/.nanoplc` / `%USERPROFILE%\.nanoplc`).
- **`nanoplc-idf.idfRelease`** — Git tag for ESP-IDF (default `v5.3.3`; align with supported release notes).
- **`nanoplc-idf.buildTarget`** — Argument to `install.bat` / `install.sh` (default `esp32s3`).
- **`nanoplc-idf.idfSetupScript`** — Absolute path to `export.ps1` or `export.sh` after install; scripts print suggested values—paste them here until auto-configuration ships.

Detailed bootstrap behaviour: see `docs/BOOTSTRAP_TOOLCHAIN.md` in the **nanoplc** monorepo root (if you cloned the full workspace). Standalone clones of this extension repo alone may omit that folder.

## Requirements

- [Visual Studio Code](https://code.visualstudio.com/) ≥ **1.85**
- Node.js **20+** (only for **development** / packaging of the extension)

For ESP-IDF setup via the bundled scripts:

- **Git** must be on `PATH`.

## Development

```bash
cd nanoplc-vscode
npm install
npm run compile
```

Press **F5** in VS Code with this folder opened to launch an **Extension Development Host**.

- TypeScript sources: `src/`
- Compiled output: `out/` (referenced by `"main"` in `package.json`)

### Packaging

The monorepo dependency `@nanoplc/ir-schema` is copied into `packaged-deps/node_modules` during `npm run compile`. Use the npm script below instead of plain `vsce package` (plain `vsce package` fails because npm junctions point outside the extension folder):

```bash
npm run package:vsix
```

This produces `nanoplc-iec-0.1.0.vsix` in the extension directory.

### Releasing the extension

Publishing uses two GitHub Actions workflows in the monorepo root (`.github/workflows/`):

| Workflow | When it runs | Result |
|----------|----------------|--------|
| **VS Code extension CI** | Push or PR to `main` when `nanoplc-vscode/`, `packages/ir-schema/`, or `firmware/` change | Builds and uploads a **workflow artifact** (`nanoplc-vscode-vsix`). Does **not** create a GitHub Release. |
| **VS Code extension release** | Push of a `vscode-v*` tag, or manual **Run workflow** | Creates a **GitHub Release** with the `.vsix` attached and release notes from commits. |

CI artifacts are only visible under **Actions → workflow run → Artifacts**. End users install from **Releases**, not from CI artifacts.

#### Publish a GitHub Release (recommended)

From the **repository root** (`nanoplc/`, not only `nanoplc-vscode/`):

1. **Bump the version** in `nanoplc-vscode/package.json` (semver, e.g. `0.1.0` → `0.1.1`).

2. **Commit and push** to `main`:

   ```bash
   git add nanoplc-vscode/package.json
   git commit -m "chore(vscode): release v0.1.1"
   git push origin main
   ```

   Wait for **VS Code extension CI** to pass (optional but recommended).

3. **Create and push a tag** that matches the new version:

   - Tag format: `vscode-v<version>` (e.g. `vscode-v0.1.1` for `"version": "0.1.1"`).
   - The release workflow fails if the tag version and `package.json` disagree.

   ```bash
   git tag vscode-v0.1.1
   git push origin vscode-v0.1.1
   ```

4. Open **Actions → VS Code extension release** and confirm the run succeeded.

5. Open **Releases** on GitHub. The new release includes:
   - `nanoplc-iec-<version>.vsix` (install via **Extensions → … → Install from VSIX…**)
   - Notes listing commits since the previous `vscode-v*` tag under `nanoplc-vscode/` and `packages/ir-schema/`

#### Re-run or publish an existing tag

If the tag already exists but the release failed or was skipped:

1. **Actions → VS Code extension release → Run workflow**
2. Enter the existing tag (e.g. `vscode-v0.1.1`) and run.

#### Local VSIX (without GitHub Releases)

```bash
cd nanoplc-vscode
npm install
npm run compile
npm run package:vsix
```

Output: `nanoplc-iec-<version>.vsix` in this directory. Share or install manually; this does not update GitHub Releases.

Bootstrap scripts shipped with the extension: `scripts/bootstrap-idf.ps1`, `scripts/bootstrap-idf.sh`.

## License

MIT — see [`LICENSE`](./LICENSE).

## Repository

[`nanoplc-vscode`](https://github.com/nanoplc/nanoplc-vscode.git) (publish metadata in `package.json` may mirror this URL).
