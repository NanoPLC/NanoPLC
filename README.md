# NanoPLC

Lightweight **PLC IDE** for VS Code / Cursor: **FBD** editing, **Virtual PLC** simulation, **IR** compile, **C codegen**, and **ESP-IDF** firmware for ESP32 (ESP32-S3 first).

**Design → Simulate → Build → Flash** — see [`docs/VIRTUAL_PLC_PLAN.md`](docs/VIRTUAL_PLC_PLAN.md) for the full roadmap and implementation status (§49).

## Repository layout

| Path | Role |
|------|------|
| [`nanoplc-vscode/`](nanoplc-vscode/) | VS Code extension — project tree, FBD canvas, compile, simulator, ESP-IDF tasks |
| [`packages/ir-schema/`](packages/ir-schema/) | IR schema, FBD compiler, C codegen, device catalog, `PlcSimulator` |
| [`firmware/`](firmware/) | Reference ESP-IDF app (`nanoplc_runtime`, `nanoplc_hal`, `nanoplc_generated`) |
| [`examples/and_gate/`](examples/and_gate/) | Minimal FBD + IR regression example |
| [`tools/codegen/`](tools/codegen/) | CLI: IR JSON → generated C |
| [`docs/`](docs/) | Architecture, IR format, toolchain bootstrap |

Each **user project** is a folder with `nanoplc.project.json`, `src/`, `build/`, and its own **`firmware/`** tree (scaffolded from the extension template on **Add device** or **Compile**).

## Quick start (extension)

1. **Install** the extension (F5 from `nanoplc-vscode/` or install a `.vsix` — see below).
2. **Setup ESP-IDF:** Command Palette → **NanoPLC: Setup ESP-IDF toolchain** — then set `nanoplc-idf.idfSetupScript` to the printed `export.ps1` / `export.sh` path ([`docs/BOOTSTRAP_TOOLCHAIN.md`](docs/BOOTSTRAP_TOOLCHAIN.md)).
3. **Open an empty folder** as workspace.
4. **NanoPLC: Add device** — pick a device from the catalog (e.g. **M5Stack StamPLC** — 8 DI / 4 DO, or **Generic ESP32-S3**). Creates `nanoplc.project.json`, FBD starter, `io-map.json`, and `firmware/`.
5. Edit **Main** in the FBD canvas (Project tree → Application → Programs). On every **Digital In**, **Digital Out**, and **Analog In** block, pick **module → channel** in properties (e.g. onboard **DO 1** vs expansion **StamPLC IO · DO 1**). Optional: **Constant** (`BOOL` / `INT` / `WORD` / …). With StamPLC, use **Add I/O module** in the device tree for **StamPLC IO** expansion (extra DO + AI over I2C).
6. **Compile** (FBD toolbar or **NanoPLC: Compile PLC program**) — validates the graph (including I/O bindings), writes `build/ir.json`, generates `firmware/components/nanoplc_generated/*.c`. When `nanoplc.buildFirmwareOnCompile` is true, also runs **`idf.py build`**.
7. **Build firmware** (FBD toolbar or **NanoPLC: Build firmware**) — same PLC compile + checks, then always runs **`idf.py build`** for the project device. Refuses to build if an I/O block has no module/channel (or symbol) assigned.
8. **NanoPLC: Run simulation** — virtual DI / DO / AI before hardware.
9. **NanoPLC: Flash firmware** — after a successful build.

**Compile vs Build firmware:** Compile = FBD → IR → C (+ optional idf build via setting). Build firmware = that pipeline (with validation) + explicit ESP-IDF build.

Device catalog and I/O templates live in [`packages/ir-schema/src/deviceCatalog.ts`](packages/ir-schema/src/deviceCatalog.ts). IR and project fields: [`docs/IR_SCHEMA.md`](docs/IR_SCHEMA.md).

## User project layout

```
my-plc/
├── nanoplc.project.json    # device, modules, drivers, programs, firmware_root
├── src/
│   ├── main.fbd.json
│   ├── io-map.json         # onboard module I/O map
│   └── modules/            # expansion module configs (e.g. stamplc_io_exp1.json)
├── build/
│   ├── ir.json
│   └── generated.manifest.json
└── firmware/               # ESP-IDF app — run idf.py from here
    ├── CMakeLists.txt
    └── components/nanoplc_generated/
```

**Important:** `idf.py build` must run inside **`my-plc/firmware/`**, not the PLC project root.

## Firmware (ESP-IDF)

Reference tree in-repo (maintainers / monorepo `examples/and_gate` with `firmware_root: "../../firmware"`):

```bash
cd firmware
idf.py set-target esp32s3
idf.py build
```

Requires ESP-IDF **v5.3** exported in the shell. `nanoplc_runtime` uses component **`esp_system`** (task WDT API) — not the removed `esp_task_wdt` component. Default target is set in `sdkconfig.defaults` (`CONFIG_IDF_TARGET="esp32s3"`).

See [`firmware/README.md`](firmware/README.md).

**StamPLC note:** onboard I/O uses the AW9523 expander (`m5_aw9523`); **StamPLC IO** expansion (`m5_stamplc_io`, I2C 0x20–0x2F) adds DO + AI; **StamPLC AC** (`m5_stamplc_ac`, I2C 0x44) adds one AC relay DO. Codegen registers HAL readers/writers from the project device tree.

## Build the extension

`npm run compile` builds `@nanoplc/ir-schema` from `packages/ir-schema/` first — install its dependencies before compiling the extension:

```bash
cd packages/ir-schema
npm install

cd ../../nanoplc-vscode
npm install
npm run compile          # syncs ir-schema + firmware-template, compiles TypeScript
npm run package:vsix     # nanoplc-iec-*.vsix
```

Install the VSIX → **Developer: Reload Window**. Details: [`nanoplc-vscode/README.md`](nanoplc-vscode/README.md).

## Key extension settings

| Setting | Default | Purpose |
|---------|---------|---------|
| `nanoplc.codegenOnCompile` | `true` | Emit `plc_program.c` + `io_hal_config.c` after compile |
| `nanoplc.buildFirmwareOnCompile` | `true` | Run `idf.py set-target` + `idf.py build` after codegen |
| `nanoplc.firmwareRoot` | `firmware` | Fallback ESP-IDF path when project has no `firmware_root` |
| `nanoplc-idf.buildTarget` | `esp32s3` | Default IDF target if project omits `device.idf_target` |
| `nanoplc-idf.idfSetupScript` | — | Path to ESP-IDF `export.ps1` / `export.sh` |

## Tests

```bash
cd packages/ir-schema
npm install   # skip if already done for extension build
npm test
```

## License

MIT — see [LICENSE](LICENSE).
