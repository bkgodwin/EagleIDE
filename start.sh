#!/usr/bin/env bash
set -Eeuo pipefail

readonly MIN_PYTHON_MAJOR=3
readonly MIN_PYTHON_MINOR=12
readonly MIN_NODE_MAJOR=18

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly VENV_DIR="$SCRIPT_DIR/.venv"
readonly REQUIREMENTS_FILE="$SCRIPT_DIR/requirements.txt"
readonly REQUIREMENTS_STAMP="$VENV_DIR/.eagleide-requirements.sha256"

log() {
  printf '[EagleIDE] %s\n' "$*"
}

fail() {
  printf '[EagleIDE] ERROR: %s\n' "$*" >&2
  exit 1
}

run_privileged() {
  if (( EUID == 0 )); then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "System packages are missing. Re-run as root or install sudo."
  fi
}

install_system_dependencies() {
  if [[ "${EAGLEIDE_SKIP_SYSTEM_PACKAGES:-0}" == "1" ]]; then
    log "Skipping operating-system package installation by request."
    return
  fi

  if command -v apt-get >/dev/null 2>&1; then
    local packages=(
      ca-certificates
      fontconfig
      fonts-dejavu-core
      nodejs
      python3
      python3-pip
      python3-venv
    )
    local missing=()
    local package
    for package in "${packages[@]}"; do
      if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
        missing+=("$package")
      fi
    done
    if (( ${#missing[@]} > 0 )); then
      log "Installing LXC system prerequisites: ${missing[*]}"
      run_privileged apt-get update
      run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
    fi
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    local packages=(
      ca-certificates
      dejavu-sans-fonts
      fontconfig
      nodejs
      python3
      python3-pip
    )
    local missing=()
    local package
    for package in "${packages[@]}"; do
      rpm -q "$package" >/dev/null 2>&1 || missing+=("$package")
    done
    if (( ${#missing[@]} > 0 )); then
      log "Installing LXC system prerequisites: ${missing[*]}"
      run_privileged dnf install -y "${missing[@]}"
    fi
    return
  fi

  log "No supported system package manager found; validating preinstalled dependencies."
}

python_is_supported() {
  "$1" -c "import sys; raise SystemExit(0 if sys.version_info >= ($MIN_PYTHON_MAJOR, $MIN_PYTHON_MINOR) else 1)" \
    >/dev/null 2>&1
}

node_is_supported() {
  local version
  version="$(node --version 2>/dev/null || true)"
  version="${version#v}"
  [[ "${version%%.*}" =~ ^[0-9]+$ ]] && (( ${version%%.*} >= MIN_NODE_MAJOR ))
}

requirements_hash() {
  "$1" - "$REQUIREMENTS_FILE" <<'PY'
import hashlib
import sys
from pathlib import Path

print(hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest())
PY
}

venv_imports_are_healthy() {
  "$1" - "$REQUIREMENTS_FILE" <<'PY' >/dev/null 2>&1
import importlib.metadata
import sys
from pathlib import Path

import bcrypt
import cryptography
import flask
import flask_socketio
import matplotlib
import numpy
import PIL
import requests
import simple_websocket

prefix = Path(sys.prefix).resolve()
for module in (flask, matplotlib, numpy, PIL):
    module_path = Path(module.__file__).resolve()
    if prefix not in module_path.parents:
        raise RuntimeError(f"{module.__name__} loaded outside the EagleIDE virtual environment")

for raw_line in Path(sys.argv[1]).read_text(encoding="utf-8").splitlines():
    requirement = raw_line.partition("#")[0].strip()
    if not requirement:
        continue
    if requirement.count("==") != 1:
        raise RuntimeError(f"Unpinned requirement: {requirement}")
    distribution, expected_version = (part.strip() for part in requirement.split("==", 1))
    if importlib.metadata.version(distribution) != expected_version:
        raise RuntimeError(f"{distribution} version does not match requirements.txt")
PY
}

prepare_virtual_environment() {
  local system_python="$1"
  local recreate=0
  if [[ ! -x "$VENV_DIR/bin/python" ]] || ! python_is_supported "$VENV_DIR/bin/python"; then
    recreate=1
  fi
  if [[ -f "$VENV_DIR/pyvenv.cfg" ]] && grep -Eiq '^include-system-site-packages[[:space:]]*=[[:space:]]*true' "$VENV_DIR/pyvenv.cfg"; then
    recreate=1
  fi

  if (( recreate == 1 )); then
    case "$VENV_DIR" in
      "$SCRIPT_DIR"/.venv|"$SCRIPT_DIR"/.venv/*) ;;
      *) fail "Refusing to replace virtual environment outside the EagleIDE directory: $VENV_DIR" ;;
    esac
    log "Creating isolated Python virtual environment."
    rm -rf -- "$VENV_DIR"
    "$system_python" -m venv "$VENV_DIR" ||
      fail "Could not create the virtual environment. Install python3-venv for this Python version."
  fi

  local venv_python="$VENV_DIR/bin/python"
  local wanted_hash
  local installed_hash=""
  wanted_hash="$(requirements_hash "$system_python")"
  [[ -f "$REQUIREMENTS_STAMP" ]] && installed_hash="$(<"$REQUIREMENTS_STAMP")"

  if [[ "$installed_hash" != "$wanted_hash" ]] || ! venv_imports_are_healthy "$venv_python"; then
    log "Installing pinned Python dependencies into $VENV_DIR."
    "$venv_python" -m pip install --disable-pip-version-check --upgrade pip
    "$venv_python" -m pip install --disable-pip-version-check --only-binary=:all: -r "$REQUIREMENTS_FILE"
    "$venv_python" -m pip check
    venv_imports_are_healthy "$venv_python" ||
      fail "The virtual environment did not pass its dependency isolation check."
    printf '%s\n' "$wanted_hash" > "$REQUIREMENTS_STAMP.tmp"
    mv -f -- "$REQUIREMENTS_STAMP.tmp" "$REQUIREMENTS_STAMP"
  else
    log "Pinned Python dependencies are already installed and healthy."
  fi
}

report_native_containment() {
  "$1" - "$SCRIPT_DIR" <<'PY'
import sys

sys.path.insert(0, sys.argv[1])
from sandbox_containment import landlock_status

status = landlock_status()
if status.get("available") and int(status.get("abi") or 0) >= 3:
    print(f"[EagleIDE] Native containment ready (Landlock ABI {status['abi']}).")
else:
    reason = status.get("reason") or "Landlock ABI 3+ is unavailable"
    print(
        "[EagleIDE] WARNING: SQLite, Inspect, NumPy, Pillow, and Matplotlib "
        f"will fail closed: {reason}",
        file=sys.stderr,
    )
    print(
        "[EagleIDE] Enable Landlock on the LXC host before assigning native-module work.",
        file=sys.stderr,
    )
PY
}

main() {
  cd "$SCRIPT_DIR"
  install_system_dependencies

  command -v python3 >/dev/null 2>&1 ||
    fail "python3 was not installed by the detected package manager."
  local system_python
  system_python="$(command -v python3)"
  python_is_supported "$system_python" ||
    fail "Python $MIN_PYTHON_MAJOR.$MIN_PYTHON_MINOR+ is required. Use Debian 13, Ubuntu 24.04+, or another supported LXC image."

  command -v node >/dev/null 2>&1 ||
    fail "Node.js is required for JavaScript execution."
  node_is_supported ||
    fail "Node.js $MIN_NODE_MAJOR+ is required; the installed version is $(node --version 2>/dev/null || echo unknown)."

  prepare_virtual_environment "$system_python"
  local venv_python="$VENV_DIR/bin/python"
  report_native_containment "$venv_python"

  log "Python: $("$venv_python" --version 2>&1)"
  log "Node.js: $(node --version)"
  if [[ "${EAGLEIDE_SETUP_ONLY:-0}" == "1" ]]; then
    log "Setup and validation complete."
    return
  fi

  log "Starting EagleIDE on ${HOST:-0.0.0.0}:${PORT:-8000}."
  exec "$venv_python" "$SCRIPT_DIR/app.py"
}

main "$@"
