# ESP-IDF bootstrap through NanoPLC

Companion document to **`VIRTUAL_PLC_PLAN.md` §48**—how the onboarding wizard helps install **ESP-IDF + toolchains** into the workstation user profile **after** installing the NanoPLC VS Code extension, without cramming gigabytes into the `.vsix`.

---

## 1. Goals

After installing NanoPLC the user should be able to:

1. Run **NanoPLC: Setup ESP-IDF toolchain (clone + install)** from the Command Palette—or (future workflow) approve the wizard on first firmware build.
2. End up with a working `idf.py` environment referencing a pinned ESP-IDF line supported by NanoPLC (**plan §40** calls out aligning tags per release cadence).
3. Copy toolchain paths surfaced in Terminal output into settings (`nanoplc-idf.*` per **plan §18**); future NanoPLC revisions may automate JSON updates.

---

## 1.1. Current `nanoplc-vscode` implementation

| Command palette entry | Behaviour |
|------------------------|-----------|
| **NanoPLC: Setup ESP-IDF toolchain (clone + install)** | Opens **NanoPLC ESP-IDF setup** terminal and invokes `scripts/bootstrap-idf.ps1` (Windows) or `scripts/bootstrap-idf.sh` (Linux/macOS) from the bundled extension folder |
| **NanoPLC: Check idf.py in PATH** | Spawns `idf.py --version`; if inactive environment, explains how to rerun Setup or set `nanoplc-idf.idfSetupScript` |
| **NanoPLC: Build / Flash / Monitor / Flash+Monitor / Set target / Diagnose** | Sources `export.ps1` or `export.sh`, runs `idf.py` in `nanoplc.firmwareRoot` (default `firmware/`) |

Scripts live inside **`nanoplc-vscode/scripts/`**: shallow `git clone --depth 1 --branch <tag>` followed by **`install.bat` / `./install.sh`** for the MCU target encoded in **`nanoplc-idf.buildTarget`**.

Install roots default to `~/.nanoplc` or `%USERPROFILE%\.nanoplc` unless **`nanoplc-idf.distRoot`** overrides. Default tag originates from **`nanoplc-idf.idfRelease`** (`v5.3.3` today—mirror release notes whenever you bump).

The extension currently **does not auto-write `settings.json`**—copy emitted paths manually or revisit future automation tasks.

---

## 2. Per-OS folder conventions

| OS | Suggested root (`nanoplc-idf.distRoot`) | Typical children |
|----|----------------------------------------|-------------------|
| Windows | `%USERPROFILE%\.nanoplc` | `esp-idf\`, cached tools |
| Linux | `~/.nanoplc` | `esp-idf/`, toolchain packages |
| macOS | `~/.nanoplc` **or** `~/Library/Application Support/NanoPLC/toolchain` — pick ONE product convention and document it visibly |

Avoid storing toolchains beside the VS Code global extension directory—it complicates reinstalls/upgrades.

---

## 3. Logical wizard choreography

1. **Disk-space preflight**—warn before multi-gigabyte downloads.
2. **Explicit consent** to download Espressif-authored installers/binaries.
3. Mode picker:
   - **Automatic** curated path per OS (**§4**).
   - **Manual** fallback for mirrored/offline installs.
4. Fetch only official GitHub Releases or Espressif installers; optionally verify checksum fingerprints.
5. Execute vendor scripts (`install.bat`/`install.sh`) or Windows installer flows exactly as upstream documents for the pinned IDF version.
6. Validate `export.ps1`/`export.sh` then run **`idf.py --version`** from a subprocess spawned with the refreshed environment.

7. Instruct operators to populate settings keys (**§18**):
   - `nanoplc-idf.distRoot`
   - `nanoplc-idf.idfSetupScript`
   - `nanoplc-idf.python` **if applicable**
   - `nanoplc-idf.idfRelease` for diagnostics dashboards

8. Emit success/errors into NanoPLC Output channel referencing expanded troubleshooting (`docs/TROUBLESHOOTING.md` someday).

---

## 4. Platform-specific acquisition tactics

### 4.1. Windows

- Prefer the official **Espressif ESP-IDF installer** tailored to pinned minors when documentation recommends it; otherwise scripted flows mirroring canonical docs suffice.
- After install persist absolute paths toward `export.ps1` plus the bundled Python virtual environment.

### 4.2. Linux / macOS

Check out **`espressif/esp-idf`** on the **exact release tag** (never drifting `HEAD` accidentally), run:

```bash
./install.sh esp32s3   # Narrow targets to shorten first-time downloads (tune release notes).
. ./export.sh
```

Targeting only mandatory SoCs accelerates `./install`.

---

## 5. Offline mode, proxies, enterprise networks

- **HTTPS proxies**: thread `HTTP(S)_PROXY` through installer subprocesses; optionally expose wizard fields when autodetection misses.
- **Custom root CAs**: allow operators to paste CA bundles or defer to OS trust roots—otherwise `git`/curl refuses TLS negotiation.
- **Offline**: wizard must accept prefetched tarball directories referencing already extracted IDFs with zero WAN calls—document prerequisites in NanoPLC release notes.

---

## 6. Supply-chain safeguards

- Only download artefacts from documented Espressif or GitHub infrastructure.
- Prefer checksum validation after retrieval.
- Log redacted proxy credentials only—never echo secrets verbatim.
- Allow experts to permanently skip bundled automation whenever they manage IDF centrally.

---

## 7. Windows antivirus interactions

Thousands of toolchain files stress realtime AV scanners—call out predictable slowdowns inside this doc and onboarding copy. Mention optional exclusions at admin discretion yet warn about corporate policy ramifications.

---

## 8. Upgrades plus side-by-side IDF copies

- Keep versioned sibling directories (`esp-idf\v5.4`, `esp-idf\v5.3`) for quick rollback workflows.
- When NanoPLC releases demand newer IDF minors, optionally enforce `nanoplc-idf.minSupportedRelease` (future knob) prompting automated upgrades.

Do **not** conflate toolchain upgrades with PLC **`ir_version`** or **`NANOPLC_RUNTIME_ABI_VERSION`**—orthogonal contracts.

---

## 9. Build integration expectations

- `nanoplc.firmwareRoot` points at firmware sources relative to workspace root.
- Automated NanoPLC firmware tasks must **`source`/dot-source identical export scripts** the wizard exercised.

When builds fail emit `idf.py --version` (or env markers) beside **`nanoplc-idf.idfRelease`** snippets for deterministic bug reports.

---

## 10. Cross references

| Resource | Highlights |
|---------|-------------|
| `VIRTUAL_PLC_PLAN.md` §48 | Thin `.vsix` + onboarding guidance |
| `VIRTUAL_PLC_PLAN.md` §40 | Supported IDF minors per NanoPLC milestone |
| `VIRTUAL_PLC_PLAN.md` §44 | Troubleshooting groundwork |
| [ESP-IDF Get Started — ESP32-S3 path](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/get-started/) | Canonical Espressif walkthrough |

---

## 11. Status

Treat this file as behavioural contract scaffolding; wire exact installer URLs/checksums/param choices into shipping release checklist once toolchain pins solidify each cycle.
