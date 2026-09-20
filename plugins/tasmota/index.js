const axios = require('axios');
const { EventEmitter } = require('events');

class TasmotaDriver extends EventEmitter {
  constructor(config) {
    super();
    this.host = config.host;
    this.name = config.name;
    this.channel = config.channel; // undefined = single, 1/2/3/4 = multi-gang
    this.state = { on: false };
    this._pollTimer = null;
  }

  get capabilities() {
    return ['power'];
  }

  // POWER key for this channel: single-relay = 'POWER', multi-gang = 'POWER1', 'POWER2' etc.
  get _powerKey() {
    return this.channel !== undefined ? `POWER${this.channel}` : 'POWER';
  }

  async init() {
    await this._poll();
    this._pollTimer = setInterval(() => this._poll(), 5000);
  }

  async _poll() {
    try {
      const { data } = await axios.get(`http://${this.host}/cm`, {
        params: { cmnd: 'Power' },
        timeout: 3000,
      });
      // Single-relay devices report POWER; multi-gang report POWER1, POWER2, etc.
      const val = data[this._powerKey] ?? data.POWER ?? data.POWER1 ?? '';
      this.state.on = val.toLowerCase() === 'on';
      this.emit('state', { ...this.state });
    } catch {}
  }

  get(capability) {
    if (capability === 'power') return this.state.on;
    return null;
  }

  async set(capability, value) {
    if (capability !== 'power') return;
    const cmd = `${this._powerKey} ${value ? 'ON' : 'OFF'}`;
    try {
      await axios.get(`http://${this.host}/cm`, {
        params: { cmnd: cmd },
        timeout: 3000,
      });
      this.state.on = Boolean(value);
      this.emit('state', { ...this.state });
    } catch (e) {
      console.warn(`[Tasmota:${this.name}] Command failed (${e.code || e.message})`);
    }
  }

  destroy() {
    clearInterval(this._pollTimer);
  }
}

module.exports = {
  name: 'tasmota',
  async init(config) {
    const driver = new TasmotaDriver(config);
    await driver.init();
    return driver;
  },
};
