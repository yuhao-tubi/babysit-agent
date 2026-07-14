#!/usr/bin/env bash
# Container entrypoint for the PR Babysitting Agent.
#
# Responsibilities, in order:
#   1. Ensure the /data mount exists.
#   2. Optionally drop to the host user's UID/GID (PUID/PGID) so files written
#      into the bind-mounted ./.data are owned by you, not root.
#   3. Load creds from the mounted .env and run `gh auth setup-git` so the
#      GH_TOKEN authorizes RAW git (clone/push), not just `gh api`.
#   4. Dispatch: setup | run (default) | doctor  (anything else runs verbatim).
set -euo pipefail

DATA_DIR="${BABYSIT_DATA_DIR:-/data}"
MOUNT_ROOT="/data"

# --- 1. data dirs -------------------------------------------------------------
mkdir -p "$DATA_DIR"

# --- 2. privilege drop (optional) --------------------------------------------
# If PUID/PGID are set (or we can infer them from the mount's owner), run the
# app as that user so ./.data files are host-editable. Default: stay root.
run_as() {
  if [ -n "${PUID:-}" ] || [ -n "${PGID:-}" ]; then
    local uid="${PUID:-0}" gid="${PGID:-0}"
    groupmod -o -g "$gid" node >/dev/null 2>&1 || groupadd -o -g "$gid" appgrp >/dev/null 2>&1 || true
    usermod  -o -u "$uid" node >/dev/null 2>&1 || true
    # `node`'s home from the image; gosu resets HOME to the target user's passwd
    # entry, so we can't override it here — inner() sets HOME explicitly instead.
    # Make sure that home is owned by the remapped uid so gh/git can write there.
    mkdir -p /home/node
    chown -R "$uid:$gid" /home/node 2>/dev/null || true
    # Only chown the mount if we own the process — cheap for small trees, the
    # repo clones can be large so we scope to the top level + creds files.
    chown "$uid:$gid" "$MOUNT_ROOT" "$DATA_DIR" 2>/dev/null || true
    [ -f "$MOUNT_ROOT/.env" ] && chown "$uid:$gid" "$MOUNT_ROOT/.env" 2>/dev/null || true
    [ -f "$MOUNT_ROOT/config.json" ] && chown "$uid:$gid" "$MOUNT_ROOT/config.json" 2>/dev/null || true
    exec gosu "$uid:$gid" "$0" "__inner__" "$@"
  fi
  exec "$0" "__inner__" "$@"
}

# --- 3. + 4. inner: git auth, then dispatch ----------------------------------
inner() {
  # HOME is unreliable across the gosu boundary (gosu resets it; a bare `docker
  # run` may leave it empty). Pin it to a writable, uid-owned dir so gh writes
  # its credential config where git will later read it.
  export HOME="${HOME:-/home/node}"
  [ -w "$HOME" ] 2>/dev/null || export HOME=/home/node
  mkdir -p "$HOME" 2>/dev/null || true

  # Load .env so GH_TOKEN is present for gh auth setup-git below. The Node
  # process loads it again itself (BABYSIT_ENV_FILE) — this is just for gh.
  if [ -f "$BABYSIT_ENV_FILE" ]; then
    set -a; . "$BABYSIT_ENV_FILE"; set +a
  fi

  local cmd="${1:-run}"; shift || true

  # A bind-mounted clone can be owned by a uid that differs from the process
  # (host-migrated repos, remapped PUID), which trips git's ownership guard.
  # Trust any repo dir — this is a single-tenant container on the user's mount.
  git config --global --add safe.directory '*' 2>/dev/null || true

  # `run` and `doctor` need git auth; `setup` runs its own gh validation.
  if [ -n "${GH_TOKEN:-${GITHUB_TOKEN:-}}" ]; then
    export GH_TOKEN="${GH_TOKEN:-$GITHUB_TOKEN}"
    export GITHUB_TOKEN="$GH_TOKEN"
    # Make raw `git push`/`clone` over HTTPS use the token, not just `gh api`.
    gh auth setup-git >/dev/null 2>&1 || true
  fi

  case "$cmd" in
    setup)  exec npm run --silent -w @babysit/server setup ;;
    doctor) exec npm run --silent -w @babysit/server doctor ;;
    run)    exec npm start ;;
    *)      exec "$cmd" "$@" ;;  # escape hatch: run an arbitrary command
  esac
}

if [ "${1:-}" = "__inner__" ]; then
  shift
  inner "$@"
else
  run_as "$@"
fi
