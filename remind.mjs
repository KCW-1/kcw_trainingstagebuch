// Push-Erinnerungen der Trainingsbeteiligung.
// Läuft als GitHub-Workflow etwa alle 15 Minuten (.github/workflows/remind.yml).
// Liest die Firebase-Datenbank über REST, sucht Spieler ohne Rückmeldung,
// deren Erinnerungszeitpunkt erreicht ist, und schickt ihnen eine Web-Push-Nachricht.
//
// Umgebung:
//   VAPID_PUBLIC, VAPID_PRIVATE  Schlüsselpaar (privat als GitHub-Secret)
//   DB_URL                       Firebase Realtime Database
//   PAGE_URL                     Adresse der Seite, für den Link in der Nachricht
//   TZ=Europe/Berlin             Termine sind in deutscher Ortszeit gespeichert
//   DRY_RUN=1                    nur anzeigen, nichts verschicken oder schreiben
//   FIREBASE_SERVICE_ACCOUNT     Dienstkonto-Schlüssel (JSON, GitHub-Secret). Seit Version 9
//                                ist die Datenbank durch Regeln geschützt, das Skript meldet
//                                sich deshalb mit diesem Dienstkonto an.

import webpush from "web-push";
import { createSign } from "node:crypto";

const DB = (process.env.DB_URL || "https://kcw-trainingstagebuch-default-rtdb.europe-west1.firebasedatabase.app").replace(/\/$/, "");
const PAGE = process.env.PAGE_URL || "https://kcw-1.github.io/kcw_trainingstagebuch/";
const DRY = !!process.env.DRY_RUN;
const NOW = process.env.NOW_MS ? +process.env.NOW_MS : Date.now();
const HOUR = 3600000;
const DEFAULT_EXC = 0, DEFAULT_REMIND = 3;
const WD = ["So","Mo","Di","Mi","Do","Fr","Sa"];
const MON = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

if (!DRY) {
  if (!process.env.VAPID_PUBLIC || !process.env.VAPID_PRIVATE) {
    console.error("VAPID_PUBLIC oder VAPID_PRIVATE fehlt.");
    process.exit(1);
  }
  webpush.setVapidDetails(PAGE, process.env.VAPID_PUBLIC, process.env.VAPID_PRIVATE);
}

// OAuth-Zugangstoken aus dem Dienstkonto (JWT, RS256), ohne zusätzliche Pakete
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
async function del(path) {
  if (DRY) return;
  const r = await fetch(`${DB}/${path}.json${q()}`, { method: "DELETE" });
  if (!r.ok) throw new Error(`DELETE ${path}: ${r.status}`);
}

const pad = (n) => (n < 10 ? "0" + n : "" + n);
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function parseISO(s) { const p = String(s || "").split("-"); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
function fmtShort(iso) { const d = parseISO(iso); return `${WD[d.getDay()]} ${d.getDate()}.${MON[d.getMonth()]}`; }
function startMs(s) {
  const d = parseISO(s.date);
  const p = String(s.time || "00:00").split(":");
  d.setHours(+p[0] || 0, +p[1] || 0, 0, 0);
  return d.getTime();
}
// wie fmtDeadline auf der Seite
function fmtDeadline(s, hours) {
  if (!hours) return "Trainingsbeginn";
  const d = new Date(startMs(s) - hours * HOUR);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
  const day = isoOf(d);
  if (day === s.date) return clock + " am Trainingstag";
  if (day === isoOf(new Date(parseISO(s.date).getTime() - 86400000))) return clock + " am Vortag";
  return `am ${fmtShort(day)} um ${clock}`;
}
function dayWord(s) {
  const today = isoOf(new Date(NOW));
  const tomorrow = isoOf(new Date(NOW + 86400000));
  if (s.date === today) return "heute";
  if (s.date === tomorrow) return "morgen";
  return "am " + fmtShort(s.date);
}
const num = (v, d, lo, hi) => { const x = parseInt(v, 10); return isNaN(x) ? d : Math.max(lo, Math.min(hi, x)); };

async function runTeam(key, stats) {
  const [team, subsAll, sentAll] = await Promise.all([get(`teams/${key}`), get(`push/${key}`), get(`pushSent/${key}`)]);
  if (!team || team.remindOn === false || !subsAll) return;
  const exc = num(team.excHours, DEFAULT_EXC, 0, 336);
  const rem = num(team.remindHours, DEFAULT_REMIND, 1, 168);
  const players = team.players || {};
  const att = team.att || {};
  const sent = sentAll || {};

  for (const [sid, s] of Object.entries(team.sessions || {})) {
    if (!s || !s.date || s.cancelled) continue;
    s.id = sid;
    const deadline = startMs(s) - exc * HOUR;
    const remindAt = deadline - rem * HOUR;
    // Fenster: Erinnerungszeit erreicht, Absagefrist noch nicht vorbei
    if (NOW < remindAt || NOW >= deadline) continue;

    for (const pid of Object.keys(players)) {
      if (att[sid] && att[sid][pid]) continue;          // hat schon eine Rückmeldung
      if (sent[sid] && sent[sid][pid]) continue;        // schon erinnert
      const subs = subsAll[pid];
      if (!subs || !Object.keys(subs).length) continue; // keine Erinnerungen eingeschaltet

      const payload = JSON.stringify({
        title: `${s.label || "Training"} ${dayWord(s)}, ${s.time} Uhr`,
        body: "Du hast dich noch nicht eingetragen. "
          + (exc ? `Absage mit Punkten bis ${fmtDeadline(s, exc)}.` : "Bitte gib bis Trainingsbeginn Bescheid."),
        tag: `tb-${key}-${sid}`,
        url: PAGE + "#/heute",
      });

      let delivered = 0;
      for (const [subKey, rec] of Object.entries(subs)) {
        if (!rec || !rec.endpoint || !rec.keys) continue;
        if (DRY) { console.log(`[dry] ${key}/${players[pid].name || pid} -> ${sid} (${subKey})`); delivered++; continue; }
        try {
          await webpush.sendNotification({ endpoint: rec.endpoint, keys: rec.keys }, payload, { TTL: Math.max(60, Math.round((deadline - NOW) / 1000)), urgency: "high" });
          delivered++;
        } catch (e) {
          if (e.statusCode === 404 || e.statusCode === 410) {
            await del(`push/${key}/${pid}/${subKey}`);   // Abo gibt es nicht mehr
            stats.removed++;
          } else {
            console.error(`Fehler ${key}/${pid}/${subKey}: ${e.statusCode || ""} ${e.body || e.message}`);
            stats.failed++;
          }
        }
      }
      if (delivered) {
        await put(`pushSent/${key}/${sid}/${pid}`, NOW);
        stats.sent++;
        console.log(`Erinnert: ${key} / ${players[pid].name || pid} / ${s.date} ${s.time}`);
      }
    }
  }

  // Aufräumen: Versandmarken für Termine, die länger als 30 Tage vorbei oder gelöscht sind
  for (const sid of Object.keys(sent)) {
    const s = (team.sessions || {})[sid];
    if (!s || startMs(s) < NOW - 30 * 86400000) await del(`pushSent/${key}/${sid}`);
  }
}

const stats = { sent: 0, removed: 0, failed: 0 };
await login();
let catalog;
try { catalog = await get("catalog/teams"); }
catch (e) {
  if (!TOKEN && /: 40[13]/.test(e.message)) {
    console.warn("Kein Zugriff auf die Datenbank. Bitte das GitHub-Secret FIREBASE_SERVICE_ACCOUNT anlegen.");
    process.exit(0);
  }
  throw e;
}
const keys = catalog ? Object.keys(catalog) : ["standard"];
for (const key of keys) {
  try { await runTeam(key, stats); }
  catch (e) { console.error(`Team ${key}: ${e.message}`); stats.failed++; }
}
console.log(`Fertig: ${stats.sent} erinnert, ${stats.removed} alte Abos entfernt, ${stats.failed} Fehler.`);
