# NanoPLC

Monorepo for the virtual PLC stack: **VS Code / Cursor extension**, **ESP-IDF firmware** skeleton, and **documentation**.

| Path | Contents |
|------|----------|
| `nanoplc-vscode/` | IEC ST / LAD / FBD language support, ESP-IDF toolchain bootstrap |
| `firmware/` | ESP32-S3 reference runtime (`nanoplc_runtime`, generated PLC stub) |
| `docs/` | Architecture and toolchain guides |

## Firmware (ESP-IDF)

From a shell with ESP-IDF exported (`export.ps1` / `export.sh`):

```bash
cd firmware
idf.py set-target esp32s3
idf.py build
```

See `firmware/README.md` and `docs/VIRTUAL_PLC_PLAN.md`.

## VS Code extension

```bash
cd nanoplc-vscode
npm ci
npm run compile
```

Use **Run Extension** from `nanoplc-vscode/` or package a `.vsix` after compile.

See `nanoplc-vscode/README.md` and `docs/BOOTSTRAP_TOOLCHAIN.md`.

## License

MIT — see [LICENSE](LICENSE).
