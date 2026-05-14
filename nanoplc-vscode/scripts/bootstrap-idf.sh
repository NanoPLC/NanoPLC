#!/usr/bin/env bash
# Bootstrap ESP-IDF into user profile — see ../../docs/BOOTSTRAP_TOOLCHAIN.md
# Prerequisites: bash, Git. Python & toolchains fetched by ./install.sh (slow download).

set -euo pipefail

INSTALL_ROOT="${1:-${HOME}/.nanoplc}"
IDF_TAG="${2:-v5.3.3}"
TARGET="${3:-esp32s3}"

if ! command -v git >/dev/null 2>&1; then
  echo "Error: Git is not available on PATH." >&2
  exit 1
fi

mkdir -p "${INSTALL_ROOT}"
IDF_PATH="${INSTALL_ROOT}/esp-idf"

if [[ -d "${IDF_PATH}/.git" ]]; then
  echo "esp-idf already present at ${IDF_PATH} - skipping clone."
  echo "Delete esp-idf folder for clean reinstall, or manually git fetch/checkout."
else
  if [[ -d "${IDF_PATH}" ]]; then
    echo "Removing incomplete folder: ${IDF_PATH}"
    rm -rf "${IDF_PATH}"
  fi
  echo "Cloning esp-idf tag ${IDF_TAG} (depth 1)..."
  git clone --depth 1 --branch "${IDF_TAG}" https://github.com/espressif/esp-idf.git "${IDF_PATH}"
fi

echo "Running ./install.sh for target ${TARGET} (may take 15-40+ minutes)..."
cd "${IDF_PATH}"
./install.sh "${TARGET}"

EXPORT_SH="${IDF_PATH}/export.sh"
echo ""
echo "--- Done ---"
echo "Suggested VS Code settings:"
echo "  nanoplc-idf.distRoot: ${INSTALL_ROOT}"
echo "  nanoplc-idf.idfRelease: ${IDF_TAG}"
echo "  nanoplc-idf.idfSetupScript: ${EXPORT_SH}"
echo ""
echo "Before idf.py: source \"${EXPORT_SH}\" in each new shell."
