#!/bin/bash
set -e

# Target directory on the Comma Three (using /data since home is volatile)
INSTALL_DIR="/data/comma-360-viewer"
REPO_URL="https://github.com/MingchenZhang/comma-360-viewer.git"
PORT=8082
PROCESS_CONFIG="/data/openpilot/system/manager/process_config.py"

BRANCH="main"

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --branch|-b) BRANCH="$2"; shift 2 ;;
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

# 4. Create run.sh wrapper for NativeProcess
echo "[3/5] Creating process manager launcher..."

cat > run.sh << 'RUNEOF'
#!/bin/bash
# Launcher for openpilot NativeProcess — handles venv activation.
# Restart logic lives in server.py (signal-transparent, in-process).
cd "$(dirname "$0")"
if [ -d .venv ]; then
    source .venv/bin/activate
fi
exec python3 server.py --port 8082 >> /tmp/comma-360-viewer.log 2>&1
RUNEOF
chmod +x run.sh
echo " -> Created run.sh"

# 5. Inject into process_config.py
echo "[4/5] Injecting into process manager..."

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

INJECT_EXIT=0
inject_process_config || INJECT_EXIT=$?

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

if [ $INJECT_EXIT -eq 0 ] && [ -f "$PROCESS_CONFIG" ] && grep -q "comma_360_viewer" "$PROCESS_CONFIG" 2>/dev/null; then
    echo " Process manager:  INJECTED (auto-starts on next reboot)"

    # Also start immediately so no reboot needed
    if [ -f "$INSTALL_DIR/run.sh" ]; then
        echo " Starting viewer now..."
        bash "$INSTALL_DIR/run.sh" &
        sleep 1
        echo "   -> Running at http://$IP_ADDR:$PORT"
    fi
elif [ $INJECT_EXIT -eq 2 ] || [ $INJECT_EXIT -eq 3 ]; then
    echo " Process manager:  NOT INJECTED (see errors above)"
    echo "   -> Run the viewer manually:"
    echo "      $INSTALL_DIR/run.sh"
else
    echo " Process manager:  not injected (openpilot not detected)"
    echo "   -> Run deploy.sh again after installing openpilot"
    echo "   -> Or start manually: $INSTALL_DIR/run.sh"
fi

echo ""
echo " Access at: http://$IP_ADDR:$PORT"
echo "============================================="
