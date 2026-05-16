#!/usr/bin/env bash
set -euo pipefail

# Syncs hcom skills from this repo to global skill directories.
# OpenCode: uses symlinks (live).
# Claude: uses real copies (stable).
#
# Usage: install-skills.sh [--force]
#   --force  Replace pre-existing real directories that are not managed symlinks.
#            Without this flag, the script skips such directories and prints a warning.

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SKILLS_DIR="$SCRIPT_DIR"

SKILLS=(hcom hcom-agent-messaging)

OPENCODE_SKILLS_DIR="${HOME}/.config/opencode/skills"
CLAUDE_SKILLS_DIR="${HOME}/.claude/skills"

sync_opencode() {
  local skill="$1"
  local src="$REPO_SKILLS_DIR/$skill"
  local dst="$OPENCODE_SKILLS_DIR/$skill"

  if [[ ! -d "$OPENCODE_SKILLS_DIR" ]]; then
    echo "[SKIP] OpenCode skills dir not found: $OPENCODE_SKILLS_DIR"
    return
  fi

  if [[ -L "$dst" ]]; then
    # Normalize both paths before comparing so relative symlink targets don't
    # cause a false mismatch and trigger an unnecessary recreate.
    local resolved_dst resolved_src
    resolved_dst="$(readlink -f "$dst" 2>/dev/null || true)"
    resolved_src="$(readlink -f "$src" 2>/dev/null || echo "$src")"
    if [[ "$resolved_dst" == "$resolved_src" ]]; then
      echo "[OK] OpenCode $skill symlink already correct"
      return
    fi
    echo "[FIX] OpenCode $skill symlink points elsewhere, updating"
    rm "$dst"
  elif [[ -e "$dst" ]]; then
    # $dst exists but is not a symlink — it may be a manually managed directory.
    # Refuse to destroy it automatically; require --force.
    if [[ "$FORCE" != "true" ]]; then
      echo "[SKIP] OpenCode $skill: $dst exists but is not a symlink. Run with --force to replace it."
      return
    fi
    echo "[FIX] OpenCode $skill exists but is not a symlink, replacing (--force)"
    rm -rf "$dst"
  fi

  ln -s "$src" "$dst"
  echo "[OK] OpenCode $skill symlink created -> $src"
}

sync_claude() {
  local skill="$1"
  local src="$REPO_SKILLS_DIR/$skill"
  local dst="$CLAUDE_SKILLS_DIR/$skill"

  if [[ ! -d "$CLAUDE_SKILLS_DIR" ]]; then
    echo "[SKIP] Claude skills dir not found: $CLAUDE_SKILLS_DIR"
    return
  fi

  if [[ -d "$dst" ]]; then
    if diff -rq "$src" "$dst" >/dev/null 2>&1; then
      echo "[OK] Claude $skill copy is up to date"
      return
    fi
    echo "[FIX] Claude $skill copy is stale, updating"
    rm -rf "$dst"
  fi

  cp -r "$src" "$dst"
  echo "[OK] Claude $skill copy created"
}

echo "=== hcom skills sync ==="
echo "Repo canonical: $REPO_SKILLS_DIR"
echo ""

for skill in "${SKILLS[@]}"; do
  sync_opencode "$skill"
  sync_claude "$skill"
done

echo ""
echo "=== done ==="
