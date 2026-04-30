#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Ensure Python 3 is available
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Please install Python 3.9+" >&2
  exit 1
fi

echo "Installing/updating Python dependencies..."
python3 -m pip install --quiet --upgrade \
  flask \
  flask-socketio \
  eventlet \
  requests \
  bcrypt

echo "Starting EagleIDE..."
python3 app.py
