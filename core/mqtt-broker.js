'use strict';

const { exec } = require('child_process');
const fs = require('fs');

const CONF_PATH = '/etc/mosquitto/conf.d/rowan-hub.conf';
const CONF = 'listener 1883\nallow_anonymous true\n';

function _exec(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function isAvailable() {
  try { await _exec('which mosquitto'); return true; } catch { return false; }
}

async function isRunning() {
  try { await _exec('systemctl is-active --quiet mosquitto'); return true; } catch { return false; }
}

function ensureConf() {
  try {
    if (!fs.existsSync(CONF_PATH)) fs.writeFileSync(CONF_PATH, CONF);
  } catch (e) {
    console.warn(`[MQTT] Could not write mosquitto config: ${e.message}`);
  }
}

async function start() {
  ensureConf();
  await _exec('systemctl start mosquitto');
}

async function stop() {
  await _exec('systemctl stop mosquitto');
}

function createClient() {
  const mqtt = require('mqtt');
  const client = mqtt.connect('mqtt://localhost:1883', {
    clientId: `rowan-hub-${Date.now()}`,
    reconnectPeriod: 5000,
    connectTimeout: 8000,
  });
  client.setMaxListeners(100);
  return client;
}

module.exports = { isAvailable, isRunning, start, stop, createClient };
