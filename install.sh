#!/bin/sh
# Установка команды /monthly для Claude Code (macOS / Linux).
#   Одной строкой:  curl -fsSL https://raw.githubusercontent.com/ashaposhnikova-hub/claude-monthly/main/install.sh | sh
#   Из папки:       sh install.sh
set -e
RAW="https://raw.githubusercontent.com/ashaposhnikova-hub/claude-monthly/main/skill"
DEST="$HOME/.claude/skills/monthly"
HERE="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)"
if ! command -v node >/dev/null 2>&1; then
  echo "Нужен Node.js 18+ (ставится вместе с Claude Code). Не найден — установите Node и повторите." >&2; exit 1
fi
MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$MAJOR" -ge 18 ] || { echo "Node.js $MAJOR слишком старый, нужен 18+." >&2; exit 1; }
mkdir -p "$DEST"
if [ -n "$HERE" ] && [ -f "$HERE/skill/monthly.mjs" ] && [ -f "$HERE/skill/SKILL.md" ]; then
  cp "$HERE/skill/monthly.mjs" "$HERE/skill/SKILL.md" "$DEST/"
else
  curl -fsSL "$RAW/monthly.mjs" -o "$DEST/monthly.mjs"
  curl -fsSL "$RAW/SKILL.md"    -o "$DEST/SKILL.md"
fi
node --check "$DEST/monthly.mjs"
echo "✓ /monthly установлен в $DEST"
echo "  Откройте новую сессию Claude Code и напишите: /monthly"
