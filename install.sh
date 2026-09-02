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
# Claude Code стирает транскрипты старше cleanupPeriodDays (по умолчанию 30 дней от последней активности):
# к середине месяца половины прошлого месяца на диске уже нет. Поднимаем до 90 дней, если задано меньше.
node - "$HOME/.claude/settings.json" <<'EOF'
const fs = require("fs"), path = require("path"), f = process.argv[2];
let s = {};
if (fs.existsSync(f)) { try { s = JSON.parse(fs.readFileSync(f, "utf8")); } catch { console.log("  ⚠ " + f + " не читается как JSON — срок хранения транскриптов не менял, задайте вручную: \"cleanupPeriodDays\": 90"); process.exit(0); } }
const was = s.cleanupPeriodDays;
if (was === undefined || Number(was) < 90) {
  s.cleanupPeriodDays = 90;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  console.log(`  Срок хранения транскриптов Claude Code: ${was === undefined ? "30 (по умолчанию)" : was} → 90 дней (${f}, cleanupPeriodDays) — иначе /monthly к середине месяца теряет начало прошлого. Вернуть: удалите этот ключ.`);
} else console.log(`  Срок хранения транскриптов уже ${was} дней — не трогаю.`);
EOF
echo "✓ /monthly установлен в $DEST"
echo "  Откройте новую сессию Claude Code и напишите: /monthly"
