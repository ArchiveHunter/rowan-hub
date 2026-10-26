'use strict';

const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const configManager = require('./config-manager');

// Root-only work (writing mosquitto config, systemctl start/stop) goes through a small helper.
// When running as the unprivileged service user it is called via a narrow sudo rule.
const HELPER_INSTALLED = '/usr/local/sbin/rowan-hub-mosquitto';
const HELPER_REPO = path.join(__dirname, '..', 'scripts', 'rowan-hub-mosquitto');

function _exec(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

function _helper(args, input = '') {
  const isRoot = process.getuid && process.getuid() === 0;
  const [cmd, argv] = isRoot
    ? ['bash', [fs.existsSync(HELPER_INSTALLED) ? HELPER_INSTALLED : HELPER_REPO, ...args]]
    : ['sudo', ['-n', HELPER_INSTALLED, ...args]];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${cmd} exited ${code}`)));
    child.stdin.end(input);
  });
}

// Broker credentials live in config.yaml → mqtt_broker; generated on first start.
function getCredentials() {
  const config = configManager.load();
  const mb = config.mqtt_broker || {};
  if (mb.username && mb.password) return { username: mb.username, password: mb.password };
  const creds = { username: 'rowan-hub', password: crypto.randomBytes(18).toString('base64url') };
  config.mqtt_broker = { ...mb, ...creds };
  configManager.save(config);
  return creds;
}

// Mosquitto 2 password-file entry: PBKDF2-SHA512, format $7$iterations$salt$hash
function passwordLine(username, password) {
  const iterations = 101;
  const salt = crypto.randomBytes(12);
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512');
  return `${username}:$7$${iterations}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function isAvailable() {
  try { await _exec('command -v mosquitto || test -x /usr/sbin/mosquitto'); return true; } catch { return false; }
}

async function isRunning() {
  try { await _exec('systemctl is-active --quiet mosquitto'); return true; } catch { return false; }
}

async function start() {
  const { username, password } = getCredentials();
  await _helper(['start'], passwordLine(username, password) + '\n');
}

async function stop() {
  await _helper(['stop']);
}

function createClient() {
  const mqtt = require('mqtt');
  const { username, password } = getCredentials();
  const client = mqtt.connect('mqtt://localhost:1883', {
    clientId: `rowan-hub-${Date.now()}`,
    username,
    password,
    reconnectPeriod: 5000,
    connectTimeout: 8000,
  });
  client.setMaxListeners(100);
  return client;
}

// ── Device connection tracking ───────────────────────────────────────────────
// Since v1.2.0 the broker needs a password, so devices set up against the old anonymous
// broker silently stop reporting. We watch for live (non-retained) messages per device and
// nudge devices to answer, so the UI can say which ones still need the username/password.

const _seen = new Map(); // 'tasmota:<topic>' | 'shelly:<mqtt_id>' → last message time
let _tracker = null;
let _trackingSince = null;

// Devices that talk to the internal broker (same rules the plugins use to pick MQTT mode)
function mqttDevices(devices) {
  return (devices || []).filter(d => d.enabled !== false && (
    d.plugin === 'tasmota' ||
    (d.plugin === 'shelly' && d.mqtt_id && String(d.generation) !== '2')
  )).map(d => ({
    id: d.id,
    name: d.name,
    plugin: d.plugin,
    key: d.plugin === 'tasmota' ? `tasmota:${d.mqtt_topic || d.id}` : `shelly:${d.mqtt_id}`,
  }));
}

function trackActivity(client) {
  _tracker = client;
  _trackingSince = Date.now();
  client.subscribe(['stat/#', 'tele/#', 'shellies/#'], () => {});
  client.on('message', (topic, _payload, packet) => {
    if (packet && packet.retain) return; // retained = could be from before the password change
    const [root, name] = topic.split('/');
    if (!name) return;
    if (root === 'shellies') _seen.set(`shelly:${name}`, Date.now());
    else if (root === 'stat' || root === 'tele') _seen.set(`tasmota:${name}`, Date.now());
  });
}

// Ask each device to report — Tasmota answers an empty POWER command, Shelly Gen1 "update"
function probe(devices) {
  if (!_tracker) return;
  for (const d of mqttDevices(devices)) {
    const [, name] = d.key.split(/:(.*)/);
    if (d.plugin === 'tasmota') _tracker.publish(`cmnd/${name}/POWER`, '');
    else _tracker.publish(`shellies/${name}/command`, 'update');
  }
}

// Status per MQTT device. `settled` = tracking long enough that silence means "not connected".
function connectionStatus(devices) {
  const settled = !!_trackingSince && Date.now() - _trackingSince > 60 * 1000;
  return {
    tracking: !!_tracker,
    settled,
    devices: mqttDevices(devices).map(d => {
      const lastSeen = _seen.get(d.key) || null;
      return { ...d, lastSeen, connected: !!lastSeen };
    }),
  };
}

module.exports = { isAvailable, isRunning, start, stop, createClient, getCredentials, trackActivity, probe, connectionStatus };
