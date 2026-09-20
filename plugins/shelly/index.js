const axios = require('axios');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

class ShellyDriver extends EventEmitter {
  constructor(config) {
    super();
    this.name = config.name;
    this.host = config.host;
    this.component = config.component || 'relay';
    this.channel = config.channel !== undefined && config.channel !== null && config.channel !== ''
      ? parseInt(config.channel) : 0;
    this._configGeneration = config.generation || 'auto';
    this.generation = null;
    this.state = { on: false, brightness: 100 };
    this._ws = null;
    this._rpcId = 1;
    this._pending = new Map();
    this._pollTimer = null;
    this._reconnectTimer = null;
  }

  get capabilities() {
    if (this.generation === 2) {
      return this.component === 'light' ? ['power', 'brightness'] : ['power'];
    }
    return this.component === 'light' ? ['power', 'brightness'] : ['power'];
  }

  async init() {
    if (this._configGeneration === '1') {
      this.generation = 1;
    } else if (this._configGeneration === '2') {
      this.generation = 2;
    } else {
      try {
        await axios.get(`http://${this.host}/rpc/Shelly.GetDeviceInfo`, { timeout: 3000 });
        this.generation = 2;
      } catch {
        this.generation = 1;
      }
    }

    if (this.generation === 1) {
      await this._pollGen1();
      this._pollTimer = setInterval(() => this._pollGen1().catch(() => {}), 5000);
    } else {
      this._connectWs();
    }
  }

  async _pollGen1() {
    const { data } = await axios.get(
      `http://${this.host}/${this.component}/${this.channel}`,
      { timeout: 5000 }
    );
    this.handleUpdate(data);
  }

  handleUpdate(raw) {
    let changed = false;
    const on = this.generation === 1 ? Boolean(raw.ison) : Boolean(raw.output);
    const brightness = raw.brightness !== undefined ? raw.brightness : this.state.brightness;
    if (on !== this.state.on) { this.state.on = on; changed = true; }
    if (brightness !== this.state.brightness) { this.state.brightness = brightness; changed = true; }
    if (changed) this.emit('state', { ...this.state });
  }

  _connectWs() {
    this._ws = new WebSocket(`ws://${this.host}/rpc`);

    this._ws.on('open', () => {
      this._sendRpc('Shelly.GetStatus', {}).then(result => {
        const key = this.component === 'light' ? `light:${this.channel}` : `switch:${this.channel}`;
        if (result[key]) this.handleUpdate(result[key]);
      }).catch(() => {});
    });

    this._ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          const { resolve, reject } = this._pending.get(msg.id);
          this._pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method === 'NotifyStatus' && msg.params) {
          const key = this.component === 'light'
            ? `light:${this.channel}` : `switch:${this.channel}`;
          if (msg.params[key]) this.handleUpdate(msg.params[key]);
        }
      } catch {}
    });

    this._ws.on('close', () => {
      this._reconnectTimer = setTimeout(() => this._connectWs(), 5000);
    });

    this._ws.on('error', () => {});
  }

  _sendRpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this._rpcId++;
      this._pending.set(id, { resolve, reject });
      this._ws.send(JSON.stringify({ id, src: 'hazel', method, params }));
    });
  }

  get(capability) {
    switch (capability) {
      case 'power':      return this.state.on;
      case 'brightness': return this.state.brightness;
      default:           return null;
    }
  }

  async set(capability, value) {
    try {
      if (this.generation === 1) {
        if (this.component === 'relay') {
          const params = new URLSearchParams({ turn: value ? 'on' : 'off' });
          await axios.post(`http://${this.host}/relay/${this.channel}`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 5000,
          });
        } else {
          const params = new URLSearchParams({ turn: this.state.on ? 'on' : 'off' });
          if (capability === 'power') params.set('turn', value ? 'on' : 'off');
          if (capability === 'brightness') params.set('brightness', String(value));
          await axios.post(`http://${this.host}/light/${this.channel}`, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 5000,
          });
        }
      } else {
        if (this.component === 'light') {
          const p = { id: this.channel };
          if (capability === 'power') p.on = Boolean(value);
          if (capability === 'brightness') p.brightness = value;
          await this._sendRpc('Light.Set', p);
        } else {
          await this._sendRpc('Switch.Set', { id: this.channel, on: Boolean(value) });
        }
      }
    } catch (e) {
      console.warn(`[Shelly:${this.name}] Command failed (${e.code || e.message})`);
    }
  }

  destroy() {
    clearInterval(this._pollTimer);
    clearTimeout(this._reconnectTimer);
    if (this._ws) this._ws.terminate();
  }
}

module.exports = {
  name: 'shelly',
  async init(config) {
    const driver = new ShellyDriver(config);
    await driver.init();
    return driver;
  },
};
