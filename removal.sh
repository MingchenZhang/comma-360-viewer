#!/bin/bash
# Remove comma-360-viewer startup injections from process_config.py and continue.sh.
# Safe to run multiple times — idempotent.
set -e

PROCESS_CONFIG="/data/openpilot/system/manager/process_config.py"
CONTINUE_SH="/data/continue.sh"

REMOVED_ANY=false

echo "============================================="
echo "  comma-360-viewer — Remove Startup Injection "
echo "============================================="
echo ""

# ---- process_config.py ---------------------------------------------------

remove_from_process_config() {
    if [ ! -f "$PROCESS_CONFIG" ]; then
        echo "process_config.py: not found, nothing to do."
        return 0
    fi

    if ! grep -q "comma_360_viewer" "$PROCESS_CONFIG" 2>/dev/null; then
        echo "process_config.py: no injection found."
        return 0
    fi

    # Remove the injected block (opening comment through closing comment).
    # The block looks like:
    #   # comma-360-viewer (injected by deploy.sh — safe to remove manually)
    #   if os.path.exists("/data/comma-360-viewer/server.py"):
    #       procs += [...]
    #   # /comma-360-viewer
    #
    # sed: delete from the opening marker through the closing marker (inclusive).

    local tmpfile="/tmp/process_config_clean.$$"
    sed '/^# comma-360-viewer (injected by deploy.sh/,/^# \/comma-360-viewer/d' \
        "$PROCESS_CONFIG" > "$tmpfile"

    # Verify the block is gone
    if grep -q "comma_360_viewer" "$tmpfile"; then
        echo "FATAL: Failed to remove injection from process_config.py."
        rm -f "$tmpfile"
        return 1
    fi

    # Syntax check the cleaned file
    if ! python3 -c "compile(open('$tmpfile').read(), '$PROCESS_CONFIG', 'exec')" 2>/dev/null; then
        echo "FATAL: Removal produced invalid Python — aborting."
        rm -f "$tmpfile"
        return 1
    fi

    mv "$tmpfile" "$PROCESS_CONFIG"
    echo "process_config.py: injection removed."
    REMOVED_ANY=true
}

# ---- continue.sh ---------------------------------------------------------

remove_from_continue_sh() {
    if [ ! -f "$CONTINUE_SH" ]; then
        echo "continue.sh: not found, nothing to do."
        return 0
    fi

    if ! grep -q "comma-360-viewer" "$CONTINUE_SH" 2>/dev/null; then
        echo "continue.sh: no injection found."
        return 0
    fi

    local tmpfile="/tmp/continue_sh_clean.$$"

    # Pass 1: remove structured deploy.sh injection (comment-enclosed block).
    sed '/^# comma-360-viewer (injected by deploy.sh/,/^# \/comma-360-viewer/d' \
        "$CONTINUE_SH" > "$tmpfile"

    # Pass 2: if any comma-360-viewer references remain (manual edits, old format),
    # remove the block: from the first mention through to its closing fi.
    if grep -q "comma-360-viewer" "$tmpfile" 2>/dev/null; then
        sed -i '/comma-360-viewer/,/^fi$/d' "$tmpfile"
    fi

    # Verify the block is gone
    if grep -q "comma-360-viewer" "$tmpfile" 2>/dev/null; then
        echo "FATAL: Failed to remove injection from continue.sh."
        rm -f "$tmpfile"
        return 1
    fi

    # Verify the file still has essential structure (cd + exec)
    if ! grep -q "^cd /data/openpilot" "$tmpfile" || ! grep -q "^exec" "$tmpfile"; then
        echo "FATAL: continue.sh appears broken after removal — missing cd or exec."
        echo "Check $tmpfile before overwriting."
        return 1
    fi

    mv "$tmpfile" "$CONTINUE_SH"
    chmod +x "$CONTINUE_SH"
    echo "continue.sh: injection removed."
    REMOVED_ANY=true
}

# ---- Run -----------------------------------------------------------------

remove_from_process_config
remove_from_continue_sh

echo ""
if $REMOVED_ANY; then
    echo "Done. Injection(s) removed."
    echo "The viewer process will stop on next reboot (not killed now)."
else
    echo "No injections found — nothing was removed."
fi
echo "============================================="
