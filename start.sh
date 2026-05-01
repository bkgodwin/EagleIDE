#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure Python 3 is available
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Please install Python 3.9+" >&2
  exit 1
fi

# Create virtual environment if it doesn't exist
VENV_DIR="$SCRIPT_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  echo "Creating virtual environment..."
  python3 -m venv "$VENV_DIR"
fi

# Activate the virtual environment
# shellcheck disable=SC1091
source "$VENV_DIR/bin/activate"

echo "Installing/updating Python dependencies..."
pip install --quiet --upgrade -r "$SCRIPT_DIR/requirements.txt"

echo "Starting EagleIDE..."
python3 app.py
