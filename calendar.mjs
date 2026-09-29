// Kalender-Abo der Trainingsbeteiligung.
// Läuft stündlich als GitHub-Workflow (.github/workflows/calendar.yml).
// Baut für jeden angemeldeten Spieler und jeden Trainer eine eigene .ics-Datei und legt sie
// in einem eigenen geheimen Gist ab. Den Link schreibt es nach calP/<team>/<spieler> bzw.
// calT/<trainer>, dort liest ihn die Seite (Regeln: nur die Person selbst).
//
// Inhalt: Spieler bekommen alle Termine ihres Teams, zu denen sie eingeladen sind (Sondertermine
// mit Auswahl nur für die Ausgewählten). Trainer bekommen alle Termine ihrer Teams, Admins aller
// Teams. Keine Rückmeldungen, keine Anzahlen.
//
// Umgebung:
//   GIST_TOKEN                GitHub-Token mit Recht "gist" (GitHub-Secret)
//   FIREBASE_SERVICE_ACCOUNT  Dienstkonto-Schlüssel (GitHub-Secret)
//   DB_URL, PAGE_URL, TZ=Europe/Berlin
//   DRY_RUN=1                 nur anzeigen, nichts schreiben

import { createSign, createHash } from "node:crypto";

const DB = (process.env.DB_URL || "https://kcw-trainingstagebuch-default-rtdb.europe-west1.firebasedatabase.app").replace(/\/$/, "");
const PAGE = process.env.PAGE_URL || "https://kcw-1.github.io/kcw_trainingstagebuch/";
const DRY = !!process.env.DRY_RUN;
const GIST = process.env.GIST_TOKEN || "";
const GH_API = process.env.GH_API || "https://api.github.com";
const NOW = process.env.NOW_MS ? +process.env.NOW_MS : Date.now();
const HOUR = 3600000;
const DEFAULT_EXC = 0;
const PAST_DAYS = 60;          // vergangene Termine so lange im Abo behalten
const FILE = "kalender.ics";
const WD = ["So","Mo","Di","Mi","Do","Fr","Sa"];
const MON = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

// ---------- Firebase (wie remind.mjs) ----------
let TOKEN = null;
async function login() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) { console.warn("FIREBASE_SERVICE_ACCOUNT fehlt, lese ohne Anmeldung."); return; }
  const sa = JSON.parse(raw);
  const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
  const iat = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", typ: "JWT" });
  const claim = b64({ iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", iat, exp: iat + 3600,
    scope: "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/firebase.database" });
  const sig = createSign("RSA-SHA256").update(head + "." + claim).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: head + "." + claim + "." + sig }) });
  if (!r.ok) throw new Error("Anmeldung Dienstkonto: " + r.status + " " + (await r.text()));
  TOKEN = (await r.json()).access_token;
}
const q = () => (TOKEN ? "?access_token=" + encodeURIComponent(TOKEN) : "");
async function get(path) {
  const r = await fetch(`${DB}/${path}.json${q()}`);
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return (await r.json()) || null;
}
async function put(path, v) {
  if (DRY) return;
  const r = await fetch(`${DB}/${path}.json${q()}`, { method: "PUT", body: JSON.stringify(v) });
  if (!r.ok) throw new Error(`PUT ${path}: ${r.status}`);
}

// ---------- GitHub Gist ----------
async function gh(method, path, body) {
  const r = await fetch(GH_API + path, { method,
    headers: { "Authorization": "Bearer " + GIST, "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kcw-trainingstagebuch" },
    body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) { const e = new Error(`${method} ${path}: ${r.status} ${await r.text()}`); e.status = r.status; throw e; }
  return r.json();
}
const rawUrl = (g) => `https://gist.githubusercontent.com/${g.owner.login}/${g.id}/raw/${FILE}`;

// ---------- Datum und Zeit ----------
const pad = (n) => (n < 10 ? "0" + n : "" + n);
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseISO(s) { const p = String(s || "").split("-"); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
const dayAdd = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
function fmtShort(iso) { const d = parseISO(iso); return `${WD[d.getDay()]} ${d.getDate()}.${MON[d.getMonth()]}`; }
const multiDay = (s) => !!s.until && s.until > s.date;
const lastDay = (s) => (multiDay(s) ? s.until : s.date);
function startMs(s) {
  const d = parseISO(s.date);
  const p = String(s.time || "00:00").split(":");
  d.setHours(+p[0] || 0, +p[1] || 0, 0, 0);
  return d.getTime();
}
function plusMinutes(t, mins) {
  const p = String(t || "").split(":");
  if (p.length < 2) return "";
  let total = ((+p[0] * 60 + +p[1]) + mins) % 1440;
  if (total < 0) total += 1440;
  return pad(Math.floor(total / 60)) + ":" + pad(total % 60);
}
function fmtDeadline(s, hours) {
  if (!hours) return (s.allDay && !s.time) ? `0 Uhr am ${fmtShort(s.date)}` : (s.sp ? "Terminbeginn" : "Trainingsbeginn");
  const d = new Date(startMs(s) - hours * HOUR);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
  const day = isoOf(d);
  if (day === s.date) return clock + " am Trainingstag";
  if (day === isoOf(new Date(parseISO(s.date).getTime() - 86400000))) return clock + " am Vortag";
  return `am ${fmtShort(day)} um ${clock}`;
}
const num = (v, d, lo, hi) => { const x = parseInt(v, 10); return isNaN(x) ? d : Math.max(lo, Math.min(hi, x)); };

// ---------- iCalendar (wie buildIcs() auf der Seite) ----------
const icsEsc = (v) => String(v == null ? "" : v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
function icsFold(line) {
  const out = []; let cur = "", bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 73) { out.push(cur); cur = " "; bytes = 1; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join("\r\n");
}
const icsDate = (iso) => iso.replace(/-/g, "");
const icsDT = (iso, hm) => icsDate(iso) + "T" + String(hm || "00:00").replace(":", "").slice(0, 4) + "00";
function utcStamp(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + "T"
    + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + "Z";
}
const TZ = ["BEGIN:VTIMEZONE","TZID:Europe/Berlin",
  "BEGIN:DAYLIGHT","TZOFFSETFROM:+0100","TZOFFSETTO:+0200","TZNAME:CEST","DTSTART:19700329T020000","RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU","END:DAYLIGHT",
  "BEGIN:STANDARD","TZOFFSETFROM:+0200","TZOFFSETTO:+0100","TZNAME:CET","DTSTART:19701025T030000","RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU","END:STANDARD",
  "END:VTIMEZONE"];

// items: [{ s, key, teamName, exc }]
function buildIcs(calName, items) {
  const L = ["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//KC Wetter//Trainingsbeteiligung//DE","CALSCALE:GREGORIAN","METHOD:PUBLISH",
    "X-WR-CALNAME:" + icsEsc(calName), "X-WR-TIMEZONE:Europe/Berlin",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H", "X-PUBLISHED-TTL:PT1H"].concat(TZ);
  items.sort((a, b) => startMs(a.s) - startMs(b.s) || a.s.id.localeCompare(b.s.id));
  for (const { s, key, teamName, exc } of items) {
    L.push("BEGIN:VEVENT");
    L.push("UID:" + s.id + "@" + key + ".kcw-trainingstagebuch");   // gleich wie beim .ics-Download
    L.push("DTSTAMP:" + utcStamp(typeof s.at === "number" ? s.at : startMs(s)));   // fest, damit sich die Datei nur bei echten Änderungen ändert
    if (s.allDay) {
      L.push("DTSTART;VALUE=DATE:" + icsDate(s.date));
      L.push("DTEND;VALUE=DATE:" + icsDate(isoOf(dayAdd(parseISO(lastDay(s)), 1))));
    } else {
      const time = s.time || "19:30";
      let endDay = lastDay(s); const endT = s.end || plusMinutes(time, 90);
      if (!multiDay(s) && endT <= time) endDay = isoOf(dayAdd(parseISO(s.date), 1));
      L.push("DTSTART;TZID=Europe/Berlin:" + icsDT(s.date, time));
      L.push("DTEND;TZID=Europe/Berlin:" + icsDT(endDay, endT));
    }
    L.push("SUMMARY:" + icsEsc((s.label || "Training") + " · " + teamName));
    if (s.place) L.push("LOCATION:" + icsEsc(s.place));
    const desc = [];
    if (s.allDay && s.time) desc.push("Treffen " + s.time + " Uhr");
    if (s.sp) desc.push("Sondertermin, außer Wertung");
    if (s.cancelled) desc.push("Fällt aus" + (s.reason ? ": " + s.reason : ""));
    else desc.push("Rückmeldung bis " + fmtDeadline(s, exc));
    desc.push(PAGE);
    L.push("DESCRIPTION:" + icsEsc(desc.join("\n")));
    L.push("URL:" + PAGE);
    L.push("STATUS:" + (s.cancelled ? "CANCELLED" : "CONFIRMED"));
    L.push("END:VEVENT");
  }
  L.push("END:VCALENDAR");
  return L.map(icsFold).join("\r\n") + "\r\n";
}

const hasWho = (s) => !!s.who && typeof s.who === "object" && Object.keys(s.who).length > 0;
const hashOf = (t) => createHash("sha256").update(t).digest("hex").slice(0, 32);

// Schreibt die Datei in den Gist der Person (legt ihn beim ersten Mal an) und merkt sich den Link.
async function publish(path, rec, calName, text, stats) {
  const h = hashOf(text);
  if (rec && rec.g && rec.h === h && rec.u) { stats.same++; return; }
  if (DRY) { console.log(`[dry] ${path}: ${rec && rec.g ? "aktualisieren" : "neu anlegen"} (${text.length} Bytes)`); stats.changed++; return; }
  let g = null;
  if (rec && rec.g) {
    try { g = await gh("PATCH", "/gists/" + rec.g, { description: calName, files: { [FILE]: { content: text } } }); }
    catch (e) { if (e.status !== 404) throw e; g = null; }   // Gist gelöscht: neu anlegen
  }
  if (!g) {
    g = await gh("POST", "/gists", { description: calName, public: false, files: { [FILE]: { content: text } } });
    stats.created++;
  } else stats.changed++;
  await put(path, { g: g.id, u: rawUrl(g), h, ts: NOW });
}

async function main() {
  if (!GIST && !DRY) { console.warn("GIST_TOKEN fehlt, Kalender-Abos werden nicht erzeugt."); return; }
  await login();
  const [teamsCat, trainers, calP, calT] = await Promise.all([get("catalog/teams"), get("catalog/trainers"), get("calP"), get("calT")]);
  const keys = Object.keys(teamsCat || {});
  const from = isoOf(new Date(NOW - PAST_DAYS * 86400000));
  const teams = {};
  for (const k of keys) {
    const t = await get(`teams/${k}`);
    if (!t) continue;
    const name = (typeof t.team === "string" && t.team) || (teamsCat[k] && teamsCat[k].name) || k;
    const exc = num(t.excHours, DEFAULT_EXC, 0, 336);
    const sessions = Object.entries(t.sessions || {})
      .filter(([, s]) => s && s.date && lastDay(s) >= from)
      .map(([id, s]) => ({ ...s, id }));
    teams[k] = { name, exc, sessions, players: t.players || {} };
  }
  const stats = { same: 0, changed: 0, created: 0, failed: 0 };

  // Spieler: nur Termine, zu denen sie eingeladen sind
  for (const [k, t] of Object.entries(teams)) {
    for (const [pid, p] of Object.entries(t.players)) {
      if (!p || !p.login || !p.login.uid) continue;          // noch kein Konto
      const items = t.sessions.filter((s) => !hasWho(s) || s.who[pid]).map((s) => ({ s, key: k, teamName: t.name, exc: t.exc }));
      const calName = `${t.name} Training`;
      try { await publish(`calP/${k}/${pid}`, calP && calP[k] && calP[k][pid], calName, buildIcs(calName, items), stats); }
      catch (e) { stats.failed++; console.error(`Spieler ${k}/${pid}: ${e.message}`); }
    }
  }

  // Trainer: alle Termine ihrer Teams, Admins aller Teams
  for (const [tid, tr] of Object.entries(trainers || {})) {
    if (!tr || !tr.login || !tr.login.uid) continue;
    const mine = tr.admin === true ? Object.keys(teams) : Object.keys(tr.teams || {}).filter((k) => teams[k]);
    const items = [];
    for (const k of mine) for (const s of teams[k].sessions) items.push({ s, key: k, teamName: teams[k].name, exc: teams[k].exc });
    const calName = mine.length === 1 ? `${teams[mine[0]].name} Training (Trainer)` : "KCW Training (Trainer)";
    try { await publish(`calT/${tid}`, calT && calT[tid], calName, buildIcs(calName, items), stats); }
    catch (e) { stats.failed++; console.error(`Trainer ${tid}: ${e.message}`); }
  }

  console.log(`Kalender: ${stats.created} neu, ${stats.changed} aktualisiert, ${stats.same} unverändert, ${stats.failed} Fehler.`);
  if (stats.failed) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
