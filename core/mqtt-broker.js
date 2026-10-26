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

module.exports = { isAvailable, isRunning, start, stop, createClient, getCredentials };
