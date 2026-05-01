#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure Python 3 is available
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Please install Python 3.9+" >&2
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
