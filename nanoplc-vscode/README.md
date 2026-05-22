# NanoPLC VS Code extension

IEC 61131-3 oriented language support (ST, LAD, FBD) and helpers for NanoPLC tooling. This package is intended to grow into a small PLC IDE: simulation, project tree, ESP-IDF build integration (see repo-level `docs/` in the nanoplc workspace).

## Features

| Area | Details |
|------|---------|
| **Languages** | Syntax highlighting for **Structured Text** (`.st`, `.iecst`), **Ladder** (`.lad`, `.ld`), **FBD** (`.fbd`) |
| **Toolchain** | Bootstrap **ESP-IDF** into your user profile (`~/.nanoplc` or `%USERPROFILE%\.nanoplc`), check `idf.py`, and **Build / Flash / Monitor** under `firmware/` |
| **Project** | `nanoplc.project.json`, **Device** tree view, FBD JSON → IR compile, `examples/and_gate` |

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
| **NanoPLC: Create project** | Scaffolds `nanoplc.project.json`, `src/main.fbd.json`, and `build/` |
| **NanoPLC: Compile PLC program** | Compiles FBD JSON to `build/ir.json` (see `docs/IR_SCHEMA.md`) |
| **NanoPLC: Run simulation** | Executes compiled IR on a scan timer; open **Simulator** panel to toggle virtual inputs |
| **NanoPLC: Stop simulation** | Stops the virtual PLC scan loop |
| **NanoPLC: Generate firmware C from IR** | Writes `plc_program.c` from existing `build/ir.json` |
| **NanoPLC: Refresh project tree** | Reloads the **Device** sidebar |
| **NanoPLC: Target platform info** | Shows the current **nanoplc.targetChip** setting (placeholder UI until deeper build wiring) |

## Simulator

After **Compile PLC program**, run **NanoPLC: Run simulation**. Use the **NanoPLC Simulator** panel to toggle digital inputs and watch outputs update each scan (default 10 ms; UI refresh capped by `nanoplc.simulatorRefreshMs`).

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

Bootstrap scripts shipped with the extension: `scripts/bootstrap-idf.ps1`, `scripts/bootstrap-idf.sh`.

## License

MIT — see [`LICENSE`](./LICENSE).

## Repository

[`nanoplc-vscode`](https://github.com/nanoplc/nanoplc-vscode.git) (publish metadata in `package.json` may mirror this URL).
