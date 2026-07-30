#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure a compatible Python is available. Current Matplotlib/NumPy wheels
# require Python 3.12 or newer.
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Please install Python 3.12+" >&2
  exit 1
fi
if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)'; then
  echo "ERROR: EagleIDE requires Python 3.12+ for the secured Matplotlib runtime." >&2
  exit 1
fi

# Create virtual environment if it doesn't exist or is broken
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ] || [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "Creating virtual environment..."
  # Remove any partial/broken venv first
  rm -rf "$VENV_DIR"
  python3 -m venv "$VENV_DIR" || {
    echo "ERROR: Failed to create virtual environment." >&2
    echo "  On Ubuntu/Debian, try: sudo apt install python3-venv python3-full" >&2
    echo "  On Fedora/RHEL, try:   sudo dnf install python3" >&2
    exit 1
  }
fi

# Verify activation script is present (extra safety check)
if [ ! -f "$VENV_DIR/bin/activate" ]; then
  echo "ERROR: Virtual environment activation script not found at $VENV_DIR/bin/activate" >&2
  echo "  The virtual environment may have been created incorrectly." >&2
  echo "  Try deleting the .venv directory and running start.sh again." >&2
  exit 1
fi

# Activate the virtual environment
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "Installing/updating Python dependencies..."
pip install --quiet --upgrade -r "$SCRIPT_DIR/requirements.txt"

echo "Starting EagleIDE..."
python3 app.py
