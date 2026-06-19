#!/bin/bash
set -e

# Target directory on the Comma Three (using /data since home is volatile)
INSTALL_DIR="/data/comma-360-viewer"
REPO_URL="https://github.com/MingchenZhang/comma-360-viewer.git"
PORT=8082
PROCESS_CONFIG="/data/openpilot/system/manager/process_config.py"
CONTINUE_SH="/data/continue.sh"

BRANCH="main"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --branch|-b) BRANCH="$2"
                      if [ -z "$BRANCH" ]; then
                          echo "Error: --branch requires a branch name" >&2; exit 1
                      fi
                      shift 2 ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

echo "============================================="
echo "      Comma 360 Viewer Installer & Runner    "
echo "============================================="
echo " Branch: $BRANCH"
echo ""

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
    echo "[1/5] Cloning comma-360-viewer repository ($BRANCH)..."
    git clone --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR"
else
    echo "[1/5] Existing installation found. Checking for updates..."
    cd "$INSTALL_DIR"
    if git fetch --all &> /dev/null; then
        echo " -> Online. Pulling latest $BRANCH..."
        git checkout "$BRANCH" 2>/dev/null || git checkout -b "$BRANCH"
        git reset --hard "origin/$BRANCH" || git reset --hard "github/$BRANCH"
    else
        echo " -> Network unreachable or offline. Using local cache..."
        git checkout "$BRANCH" 2>/dev/null || true
    fi
fi

cd "$INSTALL_DIR"

# 2.5 Clean up any leftover PID file from old deploy.sh versions
rm -f /tmp/comma-360-viewer.pid

# 3. Resolve Dependencies
echo "[2/5] Checking Python dependencies..."
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

# 4. Create run.sh wrapper for NativeProcess / continue.sh
echo "[3/5] Creating process manager launcher..."

cat > run.sh << 'RUNEOF'
#!/bin/bash
# Launcher for comma-360-viewer — handles venv activation and port safety.
# Restart logic lives in server.py (signal-transparent, in-process).

# Safety: if port is already in use, another instance is running — exit immediately.
PORT=8082
if ss -tlnp 2>/dev/null | grep -q ":$PORT " || netstat -tlnp 2>/dev/null | grep -q ":$PORT "; then
    echo "$(date): port $PORT already in use, exiting." >> /tmp/comma-360-viewer.log
    exit 0
fi

cd "$(dirname "$0")"
if [ -d .venv ]; then
    source .venv/bin/activate
fi
exec python3 server.py --port "$PORT" >> /tmp/comma-360-viewer.log 2>&1
RUNEOF
chmod +x run.sh
echo " -> Created run.sh (with port safety check)"

# ---- Injection Functions ------------------------------------------------

inject_process_config() {
    if [ ! -f "$PROCESS_CONFIG" ]; then
        echo " -> process_config.py not found at $PROCESS_CONFIG"
        echo " -> Skipping injection. Run deploy.sh again after openpilot is installed."
        return 0
    fi

    python3 << 'PYEOF'
import os, sys, re

TARGET = "/data/openpilot/system/manager/process_config.py"

# Anchor: the one line that's identical across all openpilot forks.
# We match leniently — any whitespace variation around the anchor.
ANCHOR_PATTERN = r'^managed_processes\s*=\s*\{\s*p\.name\s*:\s*p\s+for\s+p\s+in\s+procs\s*\}'

BLOCK = """
# comma-360-viewer (injected by deploy.sh — safe to remove manually)
if os.path.exists("/data/comma-360-viewer/server.py"):
    procs += [
        NativeProcess("comma_360_viewer", "/data/comma-360-viewer",
                      ["./run.sh"], only_offroad),
    ]
# /comma-360-viewer
"""

# 1. Read file
try:
    with open(TARGET) as f:
        original = f.read()
except FileNotFoundError:
    print(" -> process_config.py not found. Skipping injection.", file=sys.stderr)
    sys.exit(0)
except PermissionError:
    print("FATAL: Cannot read process_config.py (permission denied).", file=sys.stderr)
    sys.exit(4)

# 2. Check if already injected
if "comma_360_viewer" in original:
    print(" -> Already injected, skipping.")
    sys.exit(0)

# 3. Find anchor line (lenient match — handles whitespace variations)
lines = original.split("\n")
anchor_idx = None
for i, line in enumerate(lines):
    if re.match(ANCHOR_PATTERN, line):
        anchor_idx = i
        matched_line = line
        break

if anchor_idx is None:
    print("", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print("FATAL: Cannot inject — anchor line not found.", file=sys.stderr)
    print("", file=sys.stderr)
    print("Searched for pattern:", file=sys.stderr)
    print(f"  {ANCHOR_PATTERN}", file=sys.stderr)
    print("", file=sys.stderr)
    print("Last 3 lines of process_config.py:", file=sys.stderr)
    for line in lines[-3:]:
        print(f"  {line}", file=sys.stderr)
    print("", file=sys.stderr)
    print("This means your openpilot fork has changed the structure", file=sys.stderr)
    print("of process_config.py in a way this installer doesn't support.", file=sys.stderr)
    print("", file=sys.stderr)
    print("comma-360-viewer was NOT injected. The file was NOT modified.", file=sys.stderr)
    print("", file=sys.stderr)
    print("You can still run the viewer manually:", file=sys.stderr)
    print("  /data/comma-360-viewer/run.sh", file=sys.stderr)
    print("", file=sys.stderr)
    print("Please report your fork/version at:", file=sys.stderr)
    print("  https://github.com/MingchenZhang/comma-360-viewer/issues", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    sys.exit(2)

# 4. Inject the block before the anchor line
block_clean = BLOCK.strip("\n") + "\n"
lines.insert(anchor_idx, block_clean)
modified = "\n".join(lines)

# 5. Syntax check
try:
    compile(modified, TARGET, "exec")
except SyntaxError as e:
    print("", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print("FATAL: Injection produced invalid Python.", file=sys.stderr)
    print("", file=sys.stderr)
    print(f"Syntax error: {e}", file=sys.stderr)
    print("", file=sys.stderr)
    print("comma-360-viewer was NOT injected. The file was NOT modified.", file=sys.stderr)
    print("", file=sys.stderr)
    print("Please report this at:", file=sys.stderr)
    print("  https://github.com/MingchenZhang/comma-360-viewer/issues", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    sys.exit(3)

# 6. Write
try:
    with open(TARGET, "w") as f:
        f.write(modified)
except PermissionError:
    print("FATAL: Cannot write process_config.py (permission denied).", file=sys.stderr)
    sys.exit(4)

# 7. Verify — did our block actually land?
with open(TARGET) as f:
    written = f.read()
if "comma_360_viewer" not in written:
    print("FATAL: Write verification failed — injected text not found in file.", file=sys.stderr)
    sys.exit(5)

print(" -> Successfully injected comma-360-viewer into process_config.py")
PYEOF

    return $?
}

inject_continue_sh() {
    if [ ! -f "$CONTINUE_SH" ]; then
        echo " -> continue.sh not found at $CONTINUE_SH"
        echo " -> Cannot inject. Is openpilot installed?"
        return 1
    fi

    # Check if already injected
    if grep -q "comma-360-viewer" "$CONTINUE_SH" 2>/dev/null; then
        echo " -> Already injected in continue.sh, skipping."
        return 0
    fi

    # The block to inject — enclosed with comment markers
    INJECT_BLOCK='# comma-360-viewer (injected by deploy.sh — safe to remove manually)
if [ -f /data/comma-360-viewer/run.sh ]; then
    ionice -c 3 -n 7 bash /data/comma-360-viewer/run.sh &
fi
# /comma-360-viewer
'

    # Insert before the "cd /data/openpilot" line
    # Use awk to insert: match the line, print our block, then print the line
    local tmpfile="/tmp/continue_sh_inject.$$"
    awk -v block="$INJECT_BLOCK" '
        /^cd \/data\/openpilot/ && !done {
            print block
            done = 1
        }
        { print }
    ' "$CONTINUE_SH" > "$tmpfile"

    # Verify the injection landed
    if ! grep -q "comma-360-viewer" "$tmpfile"; then
        echo "FATAL: Injection into continue.sh failed — block not found after insert."
        rm -f "$tmpfile"
        return 1
    fi

    # Move into place
    mv "$tmpfile" "$CONTINUE_SH"
    chmod +x "$CONTINUE_SH"
    echo " -> Successfully injected comma-360-viewer into continue.sh"
    return 0
}

# ---- End Injection Functions -------------------------------------------

# 5. Detect existing startup injections
echo "[4/5] Checking startup configuration..."

IN_PROCESS_CONFIG=false
IN_CONTINUE_SH=false

if [ -f "$PROCESS_CONFIG" ] && grep -q "comma_360_viewer" "$PROCESS_CONFIG" 2>/dev/null; then
    IN_PROCESS_CONFIG=true
fi
if [ -f "$CONTINUE_SH" ] && grep -q "comma-360-viewer" "$CONTINUE_SH" 2>/dev/null; then
    IN_CONTINUE_SH=true
fi

INJECT_EXIT=0

if $IN_PROCESS_CONFIG || $IN_CONTINUE_SH; then
    echo " -> Startup injection already exists:"
    $IN_PROCESS_CONFIG && echo "    - process_config.py"
    $IN_CONTINUE_SH && echo "    - continue.sh"
    echo " -> Skipping injection."

    # Set INJECT_EXIT based on which exists
    if $IN_PROCESS_CONFIG; then
        INJECT_METHOD="process_config"
    else
        INJECT_METHOD="continue_sh"
    fi
else
    echo " -> No existing startup injection detected."

    # Choose injection method
    if [ -t 0 ]; then
        # Interactive terminal — offer choice
        echo ""
        echo "  Choose startup method:"
        echo ""
        echo "    [1] process_config.py (openpilot process manager)"
        echo "        • Safer: auto-stops when car is driving (ignition-aware)"
        echo "        • ⚠ Wiped on openpilot OTA update — re-run deploy.sh after updates"
        echo ""
        echo "    [2] continue.sh (AGNOS boot script)"
        echo "        • Survives openpilot OTA updates (no re-deploy needed)"
        echo "        • Runs even while driving (lower I/O priority mitigates impact)"
        echo "        • ⚠ If boot fails due to viewer issue, factory reset is the fallback"
        echo ""
        read -p "  Choice [1/2] (default: 1): " choice
    else
        # Non-interactive — default to process_config.py (safer)
        choice="1"
    fi

    case "$choice" in
        2)
            inject_continue_sh
            INJECT_METHOD="continue_sh"
            ;;
        *)
            if [ "$choice" != "1" ] && [ "$choice" != "" ]; then
                echo " -> Invalid choice '$choice', defaulting to process_config.py"
            fi
            inject_process_config
            INJECT_METHOD="process_config"
            ;;
    esac
fi

# 6. Status
echo "[5/5] Done."

# Retrieve Device IP Address for access info
IP_ADDR=$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7}' || hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "$IP_ADDR" ]; then
    IP_ADDR="<device-ip-address>"
fi

echo ""
echo "============================================="
echo " Comma 360 Viewer deployed to:"
echo "   $INSTALL_DIR"
echo ""

if [ "$INJECT_METHOD" = "process_config" ] && [ -f "$PROCESS_CONFIG" ] && grep -q "comma_360_viewer" "$PROCESS_CONFIG" 2>/dev/null; then
    echo " Startup method:  process_config.py (openpilot process manager)"
    echo "                  Auto-starts offroad. Wiped on OTA update."

    # Also start immediately so no reboot needed
    if [ -f "$INSTALL_DIR/run.sh" ]; then
        if ss -tlnp 2>/dev/null | grep -q ":$PORT " || netstat -tlnp 2>/dev/null | grep -q ":$PORT "; then
            echo "   -> Already running at http://$IP_ADDR:$PORT"
        else
            echo " Starting viewer now..."
            bash "$INSTALL_DIR/run.sh" &
            sleep 1
            echo "   -> Running at http://$IP_ADDR:$PORT"
        fi
    fi
elif [ "$INJECT_METHOD" = "continue_sh" ] && [ -f "$CONTINUE_SH" ] && grep -q "comma-360-viewer" "$CONTINUE_SH" 2>/dev/null; then
    echo " Startup method:  continue.sh (AGNOS boot script)"
    echo "                  Survives OTA. Runs at boot with low I/O priority."

    # Also start immediately
    if [ -f "$INSTALL_DIR/run.sh" ]; then
        if ss -tlnp 2>/dev/null | grep -q ":$PORT " || netstat -tlnp 2>/dev/null | grep -q ":$PORT "; then
            echo "   -> Already running at http://$IP_ADDR:$PORT"
        else
            echo " Starting viewer now..."
            ionice -c 3 -n 7 bash "$INSTALL_DIR/run.sh" &
            sleep 1
            echo "   -> Running at http://$IP_ADDR:$PORT"
        fi
    fi
else
    echo " Startup method:  not injected (openpilot not detected or injection failed)"
    echo "   -> Run deploy.sh again after installing openpilot"
    echo "   -> Or start manually: $INSTALL_DIR/run.sh"
fi

echo ""
echo " Access at: http://$IP_ADDR:$PORT"
echo "============================================="
