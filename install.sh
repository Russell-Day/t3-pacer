#!/usr/bin/env bash
# Link every skill in this repo into each harness's user-level skills directory.
#   ./install.sh
# ~/.agents/skills is the canonical location; Claude Code and Codex homes link to it.
# It doesn't install the systemd timers or a config; see README.md.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
targets=("$HOME/.claude/skills")
for d in "$HOME"/.claude_* "$HOME"/.codex "$HOME"/.codex_*; do
  [[ -d $d/skills || -f $d/settings.json || -f $d/config.toml ]] && targets+=("$d/skills")
done
mkdir -p "$HOME/.agents/skills"
for skill in "$here"/*/SKILL.md; do
  name=$(basename "$(dirname "$skill")")
  ln -sfn "$here/$name" "$HOME/.agents/skills/$name"
  echo "linked ~/.agents/skills/$name"
  for t in "${targets[@]}"; do
    mkdir -p "$t"
    ln -sfn "$HOME/.agents/skills/$name" "$t/$name"
    echo "linked $t/$name"
  done
done
