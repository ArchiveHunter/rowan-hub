const { EventEmitter } = require('events');

const OFFLINE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes with no state update
const OFFLINE_CHECK_INTERVAL_MS = 60 * 1000; // check every minute

class Registry extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // id → { config, driver, state, lastSeen }
    this._offlineState = new Map(); // id → boolean (true = currently marked offline)
    setInterval(() => this._checkOffline(), OFFLINE_CHECK_INTERVAL_MS);
  }

  register(id, config, driver) {
    const entry = { config, driver, state: { ...driver.state }, lastSeen: null };
    this.devices.set(id, entry);
    this._offlineState.set(id, false);

    driver.on('state', (state) => {
      const wasOffline = this._offlineState.get(id);
      entry.lastSeen = Date.now();
      if (wasOffline) {
        this._offlineState.set(id, false);
        this.emit('device-online', { id, name: config.name });
      }
      // Deduplicate: only forward to SSE clients when state actually changed
      const prev = JSON.stringify(entry.state);
      entry.state = { ...state };
      if (JSON.stringify(entry.state) !== prev) {
        this.emit('state', { deviceId: id, state: entry.state });
      }
    });
  }

  _checkOffline() {
    const now = Date.now();
    for (const [id, entry] of this.devices) {
      if (entry.lastSeen === null) continue; // never polled yet
      if (now - entry.lastSeen > OFFLINE_THRESHOLD_MS && !this._offlineState.get(id)) {
        this._offlineState.set(id, true);
        this.emit('device-offline', { id, name: entry.config.name });
      }
    }
  }

  getAll() {
    return [...this.devices.entries()].map(([id, { config, driver, state, lastSeen }]) => ({
      id,
      name: config.name,
      plugin: config.plugin,
      capabilities: driver.capabilities || [],
      presets: config.presets || [],
      state,
      lastSeen,
    }));
  }

  get(id) {
    const entry = this.devices.get(id);
    if (!entry) return null;
    const { config, driver, state, lastSeen } = entry;
    return {
      id,
      name: config.name,
      plugin: config.plugin,
      capabilities: driver.capabilities || [],
      presets: config.presets || [],
      state,
      lastSeen,
    };
  }

  async set(id, capability, value) {
    const entry = this.devices.get(id);
    if (!entry) throw new Error(`Unknown device: ${id}`);
    await entry.driver.set(capability, value);
  }

  unregister(id) {
    const entry = this.devices.get(id);
    if (!entry) return;
    if (typeof entry.driver.destroy === 'function') {
      try { entry.driver.destroy(); } catch {}
    }
    this.devices.delete(id);
    this._offlineState.delete(id);
  }

  getDriver(id) {
    return this.devices.get(id)?.driver ?? null;
  }
}

module.exports = { Registry };
