#!/bin/bash
set -e

# Target directory on the Comma Three (using /data since home is volatile)
INSTALL_DIR="/data/comma-360-viewer"
REPO_URL="https://github.com/MingchenZhang/comma-360-viewer.git"
PORT=8082
PID_FILE="/tmp/comma-360-viewer.pid"

echo "============================================="
echo "      Comma 360 Viewer Installer & Runner    "
echo "============================================="

# 1. Check Git & Python Installation
if ! command -v git &> /dev/null; then
    echo "Error: git is not installed or not in PATH." >&2
    exit 1
fi

if ! command -v python3 &> /dev/null; then
    echo "Error: python3 is not installed or not in PATH." >&2
    exit 1
fi

# 2. Clone or Update the Repository
if [ ! -d "$INSTALL_DIR" ]; then
    echo "[1/4] Cloning comma-360-viewer repository..."
    git clone "$REPO_URL" "$INSTALL_DIR"
else
    echo "[1/4] Existing installation found. Checking for updates..."
    cd "$INSTALL_DIR"
    # Try to fetch from remote. If offline, this will fail quickly and skip updating.
    if git fetch --all --timeout=10 &> /dev/null; then
        echo " -> Online. Pulling latest updates..."
        git reset --hard github/main || git reset --hard origin/main
    else
        echo " -> Network unreachable or offline. Skipping update, using local cache..."
    fi
fi

cd "$INSTALL_DIR"

# 3. Stop running instance if exists
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null; then
        echo "[2/4] Stopping previously running instance (PID: $OLD_PID)..."
        kill "$OLD_PID" || kill -9 "$OLD_PID"
    fi
    rm -f "$PID_FILE"
fi

# 4. Resolve Dependencies
echo "[3/4] Checking Python dependencies..."
USE_VENV=false

# First, check if system python already has capnp and zstandard (common in comma/openpilot envs)
if python3 -c "import capnp, zstandard" &> /dev/null; then
    echo " -> Found pre-installed 'pycapnp' and 'zstandard' in system environment. Using system Python."
    PYTHON_EXEC="python3"
else
    echo " -> Dependencies missing in system environment. Setting up virtual environment..."
    USE_VENV=true
    if [ ! -d ".venv" ]; then
        python3 -m venv .venv
    fi
    # Activate virtualenv
    source .venv/bin/activate
    PYTHON_EXEC="python3"
    
    echo " -> Upgrading pip and installing wheel..."
    pip install --upgrade pip wheel --quiet || echo " -> Warning: Offline, skipping pip upgrade."
    
    echo " -> Installing 'zstandard' and 'pycapnp' (this might take a moment to compile)..."
    pip install zstandard pycapnp --quiet || echo " -> Warning: Offline, using existing packages if installed."
fi

# 5. Start the Server in the Background
echo "[4/4] Starting Comma 360 Viewer server..."
if [ "$USE_VENV" = true ]; then
    source .venv/bin/activate
fi

# Start server.py in background, redirecting stdout/stderr to server.log
nohup $PYTHON_EXEC server.py --host 0.0.0.0 --port $PORT > server.log 2>&1 &
NEW_PID=$!
echo $NEW_PID > "$PID_FILE"

# 6. Retrieve Device IP Address for Access
IP_ADDR=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || hostname -I | awk '{print $1}')
if [ -z "$IP_ADDR" ]; then
    IP_ADDR="<device-ip-address>"
fi

echo "============================================="
echo " Comma 360 Viewer is now RUNNING!"
echo " PID: $NEW_PID"
echo " Log file: $INSTALL_DIR/server.log"
echo ""
echo " Access the interface in your browser at:"
echo "   --> http://$IP_ADDR:$PORT <--"
echo "============================================="
