const { EventEmitter } = require('events');

class Registry extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map(); // id → { config, driver, state, lastSeen }
  }

  register(id, config, driver) {
    const entry = { config, driver, state: { ...driver.state }, lastSeen: null };
    this.devices.set(id, entry);

    driver.on('state', (state) => {
      entry.lastSeen = Date.now();
      // Deduplicate: only forward to SSE clients when state actually changed
      const prev = JSON.stringify(entry.state);
      entry.state = { ...state };
      if (JSON.stringify(entry.state) !== prev) {
        this.emit('state', { deviceId: id, state: entry.state });
      }
    });
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
  }

  getDriver(id) {
    return this.devices.get(id)?.driver ?? null;
  }
}

module.exports = { Registry };
