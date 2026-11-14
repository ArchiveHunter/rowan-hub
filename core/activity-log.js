// Activity log: every on/off (and WLED preset) with who or what caused it — a home app over
// Matter, the website, a scene, an automation, or the device itself (wall switch, the device's
// own app, a power cut). Kept apart from the console log so it survives restarts and noise.
//
// Stored as JSON lines in activity.jsonl (gitignored), pruned to RETENTION_DAYS.

const fs = require('fs');
const path = require('path');
const describe = require('./describe');

const FILE = path.join(__dirname, '..', 'activity.jsonl');
const RETENTION_DAYS = 90;
const MAX_ENTRIES = 50000;
// A device reporting a new power state within this window of a hub command is the echo of that
// command. Plugins poll every 5s; the eWeLink cloud fallback can take longer.
const ECHO_WINDOW_MS = 30 * 1000;

const SOURCES = {
  apple: 'Apple Home',
  alexa: 'Amazon Alexa',
  google: 'Google Home',
  smartthings: 'SmartThings',
  matter: 'Matter app',
  web: 'Rowan Hub website',
  automation: 'Automation',
  device: 'At the device',
};

const VENDOR_SOURCE = { 0x1349: 'apple', 0x1384: 'apple', 0x1217: 'alexa', 0x6006: 'google', 0x110A: 'smartthings' };

let entries = [];
const pending = new Map(); // deviceId → [{ capability, value, ts }]
let fabricResolver = () => null;

function load() {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    entries = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(e => e && e.ts >= cutoff)
      .slice(-MAX_ENTRIES);
    fs.writeFileSync(FILE, entries.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o640 });
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`[Activity] Could not read ${FILE}: ${e.message}`);
    entries = [];
  }
}

function record(entry) {
  const e = { ts: Date.now(), ...entry };
  entries.push(e);
  if (entries.length > MAX_ENTRIES * 1.1) entries = entries.slice(-MAX_ENTRIES);
  try { fs.appendFileSync(FILE, JSON.stringify(e) + '\n', { mode: 0o640 }); } catch (err) {
    console.warn(`[Activity] Could not write: ${err.message}`);
  }
  const who = SOURCES[e.source] || e.source;
  console.log(`[Activity] ${e.name}: ${actionText(e)} — ${who}${e.by ? ` (${e.by})` : ''}${e.scene ? ` via scene "${e.scene}"` : ''}${e.failed ? ` — FAILED: ${e.failed}` : ''}`);
}

function actionText(e) {
  if (e.action === 'preset') return e.failed ? `tried preset “${e.detail}”` : `preset “${e.detail}”`;
  if (e.failed) return e.action === 'on' ? 'tried to turn on' : 'tried to turn off';
  return e.action === 'on' ? 'turned on' : 'turned off';
}

function toAction(capability, value) {
  if (capability === 'power') return { action: value === true || value === 'true' ? 'on' : 'off' };
  if (capability === 'hvacMode') return { action: Number(value) === 0 ? 'off' : 'on' };
  if (capability === 'preset') return { action: 'preset', detail: String(value) };
  return null; // brightness, colour etc. aren't logged
}

// ─── Origins ──────────────────────────────────────────────────────────────────
// An origin says who asked: { source, by?, scene? }

// bridge.js supplies fabricIndex → { vendorId, label }
function setFabricResolver(fn) { fabricResolver = fn; }

// From the context matter.js passes to `$Changing` listeners. Local writes (our own state sync)
// carry no fabric and return null.
function matterOrigin(context) {
  if (context?.fabric === undefined) return null;
  let fabric = null;
  try { fabric = fabricResolver(context.fabric); } catch {}
  const source = VENDOR_SOURCE[fabric?.vendorId] || 'matter';
  // The controller's node ID — each home hub / phone in a home app may have its own
  let by = '';
  try {
    const id = context.subject?.id ?? context.subject;
    if (id !== undefined && id !== null) by = `controller ${BigInt(id).toString(16).toUpperCase().slice(-6)}`;
  } catch {}
  if (source === 'matter' && fabric) by = [describe.controllerName(fabric), by].filter(Boolean).join(', ');
  return { source, by };
}

function webOrigin(req, user) {
  const ip = String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
  return { source: 'web', by: [user, ip, browserName(req.headers['user-agent'])].filter(Boolean).join(' · ') };
}

function browserName(ua = '') {
  const device = /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android'
    : /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari' : /curl/i.test(ua) ? 'curl' : '';
  return [device, browser].filter(Boolean).join(' ');
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

// Sends a hub command via `send()` and logs it with its outcome. Remembers it first, so the
// device's echo isn't mistaken for someone using the device directly.
async function run(deviceId, name, capability, value, origin, send) {
  const act = toAction(capability, value);
  if (!act) return send();
  const ts = Date.now();
  const list = (pending.get(deviceId) || []).filter(p => ts - p.ts < ECHO_WINDOW_MS);
  list.push({ on: act.action === 'preset' ? true : act.action === 'on', ts });
  pending.set(deviceId, list);
  const entry = { ts, device: deviceId, name, ...act, ...(origin || { source: 'unknown' }) };
  try {
    const result = await send();
    record(entry);
    return result;
  } catch (e) {
    // A command that didn't reach the device mustn't read as if it switched anything
    record({ ...entry, failed: String(e.message || e).slice(0, 200) });
    throw e;
  }
}

// Device reported state. A power change nobody here asked for happened at the device.
function observe(deviceId, name, prev, next) {
  if (typeof prev?.on !== 'boolean' || typeof next?.on !== 'boolean' || prev.on === next.on) return;
  // Matches aren't used up: a driver can report one command several times (eWeLink reports
  // straight away, then a poll that started before the command can bounce back the old state)
  const list = (pending.get(deviceId) || []).filter(p => Date.now() - p.ts < ECHO_WINDOW_MS);
  pending.set(deviceId, list);
  if (list.some(p => p.on === next.on)) return;
  record({ device: deviceId, name, action: next.on ? 'on' : 'off', source: 'device',
    by: 'wall switch, the device’s own app, or power returning' });
}

// ─── Reading ──────────────────────────────────────────────────────────────────

function query({ device, source, action, days = 7, limit = 500 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < limit; i--) {
    const e = entries[i];
    if (e.ts < cutoff) break;
    if (device && e.device !== device) continue;
    if (source && e.source !== source) continue;
    if (action && e.action !== action) continue;
    out.push(e);
  }
  // Commands are written once they finish, so a slow one can land after a later entry
  return out.sort((a, b) => b.ts - a.ts);
}

function sourceName(source) { return SOURCES[source] || source; }

load();
setInterval(load, 6 * 3600 * 1000).unref(); // prune old entries

module.exports = {
  run, observe, record, query, matterOrigin, webOrigin, setFabricResolver,
  sourceName, actionText, SOURCES, RETENTION_DAYS,
};
