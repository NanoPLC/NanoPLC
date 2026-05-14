# NanoPLC VS Code extension

IEC 61131-3 oriented language support (ST, LAD, FBD) and helpers for NanoPLC tooling. This package is intended to grow into a small PLC IDE: simulation, project tree, ESP-IDF build integration (see repo-level `docs/` in the nanoplc workspace).

## Features

| Area | Details |
|------|---------|
| **Languages** | Syntax highlighting for **Structured Text** (`.st`, `.iecst`), **Ladder** (`.lad`, `.ld`), **FBD** (`.fbd`) |
| **Toolchain** | Command to bootstrap **ESP-IDF** into your user profile (`~/.nanoplc` or `%USERPROFILE%\.nanoplc`), plus `idf.py` check |
| **Settings** | Target chip preset, firmware folder, ESP-IDF install path/tag |

## Commands

Open the Command Palette (**Ctrl+Shift+P** / **Cmd+Shift+P**) and run:

| Command | Purpose |
|---------|---------|
| **NanoPLC: Setup ESP-IDF toolchain (clone + install)** | Clones tagged [esp-idf](https://github.com/espressif/esp-idf) (shallow) and runs `install.bat` / `install.sh` for the configured target—needs Git, disk space, and network |
| **NanoPLC: Check idf.py in PATH** | Runs `idf.py --version`—use after `export.ps1` / `export.sh` in the same terminal, or integrate into your workflow |
| **NanoPLC: Target platform info** | Shows the current **nanoplc.targetChip** setting (placeholder UI until deeper build wiring) |

## Settings

Open **Settings** and filter by **NanoPLC**.

**NanoPLC**

- **`nanoplc.targetChip`** — MCU preset (`esp32-s3` default among enum values).
- **`nanoplc.firmwareRoot`** — Relative path from the workspace root to the ESP-IDF app (default `firmware`).

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

Bootstrap scripts shipped with the extension: `scripts/bootstrap-idf.ps1`, `scripts/bootstrap-idf.sh`.

## License

MIT — see [`LICENSE`](./LICENSE).

## Repository

[`nanoplc-vscode`](https://github.com/nanoplc/nanoplc-vscode.git) (publish metadata in `package.json` may mirror this URL).
