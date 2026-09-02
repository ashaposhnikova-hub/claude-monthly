#!/usr/bin/env node
/**
 * /monthly — сводка работы в Claude Code за месяц для месячного отчёта в Hive.
 *
 * Читает локальные транскрипты сессий (~/.claude/projects/<проект>/<сессия>.jsonl —
 * те же файлы, которые ежедневно уходят в /report), и собирает из них ОДИН текстовый
 * файл: по дням — проекты/сайты, задачи (ваши запросы), итог сессии, инструменты,
 * оценка активного времени. Файл вы сами загружаете в Hive → «Отчёты», ИИ Hive
 * строит по нему one-pager.
 *
 * Ничего никуда не отправляет. Секреты вырезаются теми же правилами, что в /report.
 *
 * Запуск:
 *   node ~/.claude/skills/monthly/monthly.mjs                 # прошлый месяц
 *   node ~/.claude/skills/monthly/monthly.mjs --month 2026-08
 *   node ~/.claude/skills/monthly/monthly.mjs --month 2026-08 --out "~/Documents/отчёт.txt"
 *   node ~/.claude/skills/monthly/monthly.mjs --dry-run       # только статистика, без файла
 *   node ~/.claude/skills/monthly/monthly.mjs --name "Иванов Егор"
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const HOME = os.homedir();
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const GAP_LIMIT_MS = 30 * 60 * 1000;      // пауза >30 мин не считается рабочим временем
const MAX_PROMPTS_PER_SESSION = 8;
const PROMPT_CHARS = 220;
const RECAP_CHARS = 500;

// ───────────── аргументы ─────────────
const argv = process.argv.slice(2);
const getOpt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const has = (name) => argv.includes(name);
if (has("--help") || has("-h")) {
  console.log(fs.readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?\s?/, "").replace(/^ \* ?/gm, ""));
  process.exit(0);
}

function prevMonthKey() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const month = getOpt("--month") || prevMonthKey();
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { console.error(`Неверный месяц: ${month}. Формат YYYY-MM, например 2026-08`); process.exit(2); }
const [Y, M] = month.split("-").map(Number);
const MONTHS_RU = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
const MONTHS_RU_GEN = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
const WEEKDAYS_RU = ["вс","пн","вт","ср","чт","пт","сб"];
const monthTitle = `${MONTHS_RU[M - 1]} ${Y}`;
const employeeName = getOpt("--name") || "";
const dryRun = has("--dry-run");
const outArg = getOpt("--out");
const outPath = outArg
  ? path.resolve(outArg.replace(/^~(?=$|\/)/, HOME))
  : path.join(HOME, "Documents", "Отчёты Hive", `Отчёт Claude Code — ${monthTitle}.txt`);

// ───────────── вырезка секретов (как в /report) ─────────────
const REDACTIONS = [
  [/psk_[A-Za-z0-9_-]{16,}/g, "psk"],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]+?-----END[^-]+-----/g, "private_key"],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "jwt"],
  [/ya29\.[A-Za-z0-9_-]+/g, "gcp_access"],
  [/GOCSPX-[A-Za-z0-9_-]+/g, "gocspx"],
  [/\b(?:A3T[A-Z0-9]|AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, "aws_akid"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, "github_pat"],
  [/\bxox[baprs]-[A-Za-z0-9-]+/g, "slack"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "anthropic_key"],
  [/\bsk-[A-Za-z0-9]{20,}/g, "openai_key"],
  [/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g, "supabase_key"],
  [/\b[a-z][-a-z0-9]*@[a-z][-a-z0-9]*\.iam\.gserviceaccount\.com\b/gi, "gcp_sa_email"],
  [/"private_key_id"\s*:\s*"[0-9a-f]{16,}"/g, "gcp_private_key_id"],
  [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "ipv4"],
  [/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^@\s/]+:[^@\s/]+@/gi, "conn_string"],
  [/https?:\/\/[^\s:@/]+:[^\s:@/]+@/g, "basic_auth_url"],
  [/Bearer\s+[A-Za-z0-9._-]{12,}/g, "bearer"],
  [/((?:api[_-]?key|apikey|secret|token|password|passwd|pwd|client[_-]?secret)\s*[=:]\s*["']?)([^\s"']{6,})/gi, "secret_assignment"],
];
function redact(s) {
  if (typeof s !== "string" || !s) return s;
  let out = s;
  for (const [re, label] of REDACTIONS) {
    out = out.replace(re, (m, p1) => (label === "secret_assignment" ? `${p1}[скрыто:${label}]` : `[скрыто:${label}]`));
  }
  return out;
}

// ───────────── сайты из пути проекта / git remote ─────────────
const DOMAIN_RE = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:com|net|org|io|co|ai|dev|app|me|info|biz|ru|de|fr|es|it|nl|eu|uk|cy))\b/gi;
const CODE_HOSTS = new Set(["github.com","gitlab.com","bitbucket.org","github.io","gitlab.io","npmjs.com","pypi.org","git.sr.ht","codeberg.org","dev.azure.com",
  // сервисы, а не сайты, над которыми идёт работа
  "google.com","gmail.com","googleapis.com","googleusercontent.com","gserviceaccount.com","claude.ai","anthropic.com","openai.com","openrouter.ai",
  "t.me","telegram.org","mail.ru","yandex.ru","yandex.com","vk.com","instagram.com","facebook.com","youtube.com","wikipedia.org","wikireading.ru",
  "cloudflare.com","apple.com","microsoft.com","amazon.com","amazonaws.com","macosicons.com","consultant.ru","government.ru","kg-connect.com","key-g.com","hivewe.local"]);
const remoteCache = new Map();
function gitRemoteOf(cwd) {
  if (!cwd) return null;
  if (remoteCache.has(cwd)) return remoteCache.get(cwd);
  let r = null;
  try { r = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim(); } catch {}
  remoteCache.set(cwd, r);
  return r;
}
function detectDomains(...sources) {
  const found = new Set();
  for (const src of sources) {
    if (!src) continue;
    for (const m of String(src).matchAll(DOMAIN_RE)) { const d = m[1].toLowerCase(); if (!CODE_HOSTS.has(d)) found.add(d); }
  }
  return [...found];
}

// ───────────── разбор транскриптов ─────────────
function localDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const NOISE_PREFIX = /^\s*(<command-name>|<local-command-stdout>|<local-command-caveat>|<system-reminder>|<task-notification>|<bash-input>|<bash-stdout>|<bash-stderr>|Caveat:|\[Request interrupted)/;
function cleanPrompt(s) {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
          .replace(/<[^>\n]{1,40}>/g, " ")
          .replace(/^[\s❯>]+/, "")
          .replace(/\s+/g, " ").trim();
}
function plural(n, one, few, many) { const m10 = n % 10, m100 = n % 100; return `${n} ${m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many}`; }
function oneLine(s, n) { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
// «го», «все ок», «1 2 го», «[Image #1]», «/code-review», «--chrome» — не задачи, а подтверждения и служебные строки
function isInformative(p) {
  if (/^[-—–]{1,2}[a-z]/i.test(p) || /^\/[a-z0-9:_-]+$/i.test(p)) return false;
  const words = p.replace(/\[Image #\d+\]/g, " ").match(/[\p{L}\p{N}]{3,}/gu) || [];
  const meaningful = words.filter(w => !/^(го|ок|окей|да|нет|давай|дальше|всё|все|норм|угу|ага|go|ok|yes|done|next)$/i.test(w));
  return meaningful.length >= 3 || p.length >= 60;
}
function stripMarkdown(s) {
  return s.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1").replace(/\*\*|__/g, "")
          .replace(/^#{1,6}\s+/gm, "").replace(/^\s*[|:-]+\s*$/gm, " ").replace(/\|/g, " · ").replace(/\s+·\s+·\s+/g, " · ");
}

const sessions = new Map(); // sessionId -> данные
let dirs = [];
try { dirs = fs.readdirSync(PROJECTS_DIR).map(d => path.join(PROJECTS_DIR, d)).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }); }
catch { console.error(`Нет папки ${PROJECTS_DIR} — Claude Code ещё не запускался на этом компьютере?`); process.exit(1); }

for (const dir of dirs) {
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".jsonl")); } catch { continue; }
  for (const f of files) {
    // быстрый отсев по дате изменения файла: сессия, закрытая до начала месяца, не нужна
    let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
    if (st.mtime < new Date(Y, M - 1, 1)) continue;
    let raw = ""; try { raw = fs.readFileSync(path.join(dir, f), "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.isSidechain) continue;
      if (o.type !== "user" && o.type !== "assistant") continue;
      const ts = o.timestamp; if (!ts) continue;
      const day = localDate(ts);
      if (!day.startsWith(month + "-")) continue;
      const sid = o.sessionId || f.replace(/\.jsonl$/, "");
      let s = sessions.get(sid);
      if (!s) {
        s = { id: sid, dir, cwd: null, branch: null, days: new Map(), prompts: [], tools: {}, skills: new Set(), mcp: new Set(), files: new Set(), recap: "", stamps: [], userStamps: [], userMsgs: 0, asstMsgs: 0, allPromptText: "" };
        sessions.set(sid, s);
      }
      if (!s.cwd && o.cwd) s.cwd = o.cwd;
      if (!s.branch && o.gitBranch && o.gitBranch !== "HEAD") s.branch = o.gitBranch;
      s.stamps.push(new Date(ts).getTime());
      s.days.set(day, (s.days.get(day) || 0) + 1);
      const msg = o.message || {};
      const content = msg.content;
      if (o.type === "user" && !o.isMeta && (typeof content === "string" || (Array.isArray(content) && !content.some(b => b && b.type === "tool_result")))) s.userStamps.push(new Date(ts).getTime());
      if (o.type === "user") {
        if (o.isMeta) continue;
        let text = "";
        if (typeof content === "string") text = content;
        else if (Array.isArray(content)) {
          if (content.some(b => b && b.type === "tool_result")) continue;
          text = content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
        }
        const cmd = text.match(/<command-name>\s*\/?([a-z0-9:_-]+)/i);
        if (cmd) { s.skills.add(cmd[1]); continue; }
        if (!text.trim() || NOISE_PREFIX.test(text)) continue;
        const p = cleanPrompt(text);
        if (!p) continue;
        s.userMsgs++;
        s.allPromptText += " " + p.slice(0, 2000);
        if (!isInformative(p)) continue;
        s.prompts.push({ day, text: oneLine(p, PROMPT_CHARS) });
      } else {
        s.asstMsgs++;
        if (!Array.isArray(content)) continue;
        for (const b of content) {
          if (!b) continue;
          if (b.type === "tool_use") {
            const name = b.name || "tool";
            s.tools[name] = (s.tools[name] || 0) + 1;
            const inp = b.input || {};
            if (name === "Skill" && inp.skill) s.skills.add(String(inp.skill));
            if (name.startsWith("mcp__")) s.mcp.add(name.split("__")[1] || name);
            if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name) && inp.file_path) s.files.add(String(inp.file_path));
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim().length >= 80) {
            s.recap = b.text; // последний содержательный ответ = итог сессии
          }
        }
      }
    }
  }
}

// ───────────── агрегация ─────────────
// Активное время = объединение времени ВАШИХ запросов по всем сессиям за день: параллельные окна не
// складываются, ночная работа агента без вас не считается, паузы дольше 30 минут не считаются.
// Это оценка, а не учёт рабочего времени.
function activeHours(stamps) {
  if (stamps.length < 2) return stamps.length ? 0.1 : 0;
  const a = [...new Set(stamps)].sort((x, y) => x - y);
  let ms = 0;
  for (let i = 1; i < a.length; i++) { const gap = a[i] - a[i - 1]; if (gap <= GAP_LIMIT_MS) ms += gap; }
  return Math.max(0.1, Math.round(ms / 360000) / 10);
}
function topDomainsInText(text, limit = 3) {
  const freq = new Map();
  for (const m of String(text || "").matchAll(DOMAIN_RE)) { const d = m[1].toLowerCase(); if (!CODE_HOSTS.has(d)) freq.set(d, (freq.get(d) || 0) + 1); }
  return [...freq.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([d]) => d);
}
function projectNameOf(s) {
  if (s.cwd === HOME) return "~ (домашняя папка)";
  if (s.cwd) return path.basename(s.cwd) || s.cwd;
  return path.basename(s.dir).replace(/^-Users-[^-]+-?/, "").replace(/-/g, "/") || "—";
}

const byDay = new Map(); // day -> [{session-summary}]
const byProject = new Map();
const dayStamps = new Map();      // day -> все метки времени за день (для активного времени)
const projectDayStamps = new Map(); // project -> day -> метки
let totalPrompts = 0;
for (const s of sessions.values()) {
  if (!s.userMsgs && !s.asstMsgs) continue;
  const project = projectNameOf(s);
  const domains = [...new Set([...detectDomains(s.cwd, s.dir, gitRemoteOf(s.cwd)), ...topDomainsInText(s.allPromptText + " " + s.recap)])].slice(0, 4);
  const firstDay = [...s.days.keys()].sort()[0];
  for (const t of s.userStamps) {
    const d = localDate(t);
    (dayStamps.get(d) || dayStamps.set(d, []).get(d)).push(t);
    const pd = projectDayStamps.get(project) || projectDayStamps.set(project, new Map()).get(project);
    (pd.get(d) || pd.set(d, []).get(d)).push(t);
  }
  const item = {
    project, domains, branch: s.branch,
    prompts: s.prompts.map(p => p.text).slice(0, MAX_PROMPTS_PER_SESSION),
    nPrompts: s.prompts.length,
    recap: oneLine(redact(cleanPrompt(stripMarkdown(s.recap))), RECAP_CHARS),
    tools: s.tools, skills: [...s.skills].sort(), mcp: [...s.mcp].sort(), nFiles: s.files.size,
    start: new Date(Math.min(...s.stamps)), end: new Date(Math.max(...s.stamps)),
  };
  (byDay.get(firstDay) || byDay.set(firstDay, []).get(firstDay)).push(item);
  const pr = byProject.get(project) || byProject.set(project, { days: new Set(), sessions: 0, prompts: 0, hours: 0, domains: new Map() }).get(project);
  pr.days.add(firstDay); pr.sessions++; pr.prompts += item.nPrompts; item.domains.forEach(d => pr.domains.set(d, (pr.domains.get(d) || 0) + 1));
  totalPrompts += item.nPrompts;
}
const dayHoursMap = new Map([...dayStamps.entries()].map(([d, st]) => [d, activeHours(st)]));
const totalHours = [...dayHoursMap.values()].reduce((a, b) => a + b, 0);
for (const [name, pd] of projectDayStamps.entries()) {
  const pr = byProject.get(name); if (!pr) continue;
  pr.hours = [...pd.values()].reduce((a, st) => a + activeHours(st), 0);
}
const days = [...byDay.keys()].sort();
const nSessions = [...byDay.values()].reduce((a, v) => a + v.length, 0);

const fmtDay = (day) => { const d = new Date(day + "T12:00:00"); return `${String(d.getDate()).padStart(2, "0")} ${MONTHS_RU_GEN[d.getMonth()]} (${WEEKDAYS_RU[d.getDay()]})`; };
const fmtTime = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
const fmtH = (h) => String(Math.round(h * 10) / 10).replace(".", ",");

// ───────────── статистика ─────────────
console.log(`Месяц: ${monthTitle}`);
console.log(`Рабочих дней с Claude Code: ${days.length} · сессий: ${nSessions} · ваших запросов: ${totalPrompts} · время работы с Claude Code (оценка): ~${fmtH(totalHours)} ч`);
console.log(`Проекты: ${[...byProject.keys()].join(", ") || "—"}`);
if (!days.length) { console.log("За этот месяц сессий не найдено — файл не создан."); process.exit(0); }
if (dryRun) { console.log("(--dry-run: файл не записан)"); process.exit(0); }

// ───────────── текст отчёта ─────────────
const L = [];
L.push(`ОТЧЁТ О РАБОТЕ В CLAUDE CODE — ${monthTitle.toUpperCase()}`);
if (employeeName) L.push(`Сотрудник: ${employeeName}`);
L.push(`Сформировано: ${new Date().toLocaleDateString("ru-RU")} командой /monthly из локальных транскриптов сессий`);
L.push("");
L.push(`ИТОГО ЗА МЕСЯЦ: ${plural(days.length, "рабочий день", "рабочих дня", "рабочих дней")} · ${plural(nSessions, "сессия", "сессии", "сессий")} · ${plural(totalPrompts, "запрос", "запроса", "запросов")} · ~${fmtH(totalHours)} ч работы с Claude Code (оценка по вашим запросам, паузы дольше 30 минут не считаются; это не учёт рабочего времени)`);
L.push("");
L.push("РЕЗЮМЕ МЕСЯЦА");
L.push("[РЕЗЮМЕ: заполняется при запуске /monthly — 8–15 строк: что сделано по каждому проекту, результаты, цифры]");
L.push("");
L.push("ПО ПРОЕКТАМ");
for (const [name, p] of [...byProject.entries()].sort((a, b) => b[1].hours - a[1].hours)) {
  const top = [...p.domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([d]) => d);
  L.push(`• ${name}${top.length ? ` (${top.join(", ")})` : ""} — ${plural(p.days.size, "день", "дня", "дней")}, ${plural(p.sessions, "сессия", "сессии", "сессий")}, ${plural(p.prompts, "запрос", "запроса", "запросов")}, ~${fmtH(p.hours)} ч`);
}
L.push("");
L.push("ПО ДНЯМ");
for (const day of days) {
  const items = byDay.get(day).sort((a, b) => a.start - b.start);
  const dayHours = dayHoursMap.get(day) || 0;
  const domFreq = new Map(); items.flatMap(i => i.domains).forEach(d => domFreq.set(d, (domFreq.get(d) || 0) + 1));
  const dayDomains = [...domFreq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d]) => d);
  L.push("");
  L.push(`── ${fmtDay(day)} · ${plural(items.length, "сессия", "сессии", "сессий")} · ~${fmtH(dayHours)} ч${dayDomains.length ? ` · ${dayDomains.join(", ")}` : ""} ──`);
  for (const it of items) {
    L.push(`${fmtTime(it.start)}–${fmtTime(it.end)} · ${it.project}${it.branch ? ` (ветка ${it.branch})` : ""}${it.domains.length ? ` · ${it.domains.join(", ")}` : ""}`);
    if (it.prompts.length) {
      L.push("  Задачи:");
      for (const p of it.prompts) L.push(`    • ${redact(p)}`);
      if (it.nPrompts > it.prompts.length) L.push(`    … ещё ${it.nPrompts - it.prompts.length} запросов`);
    }
    if (it.recap) L.push(`  Итог: ${it.recap}`);
    const tools = Object.entries(it.tools).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(", ");
    const extra = [tools && `инструменты: ${tools}`, it.skills.length && `скиллы: ${it.skills.map(x => "/" + x).join(", ")}`, it.mcp.length && `MCP: ${it.mcp.join(", ")}`, it.nFiles && `файлов изменено: ${it.nFiles}`].filter(Boolean).join(" · ");
    if (extra) L.push(`  ${extra}`);
  }
}
L.push("");
L.push("Примечание: «Задачи» — ваши запросы к Claude Code в том виде, как вы их писали; «Итог» — последний содержательный ответ в сессии. Секреты и IP-адреса вырезаны автоматически.");

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, L.join("\n"), "utf8");
console.log(`Файл: ${outPath} (${Math.round(fs.statSync(outPath).size / 1024)} КБ)`);
