const WebSocket = require('ws');
const axios = require('axios');
const { EventEmitter } = require('events');
const { rgbToHsl, hslToRgb } = require('../../core/color');

class WledDriver extends EventEmitter {
  constructor(config) {
    super();
    this.host = config.host;
    this.name = config.name;
    this.presetMap = {};   // name → id
    this.idToPreset = {};  // id → name
    this.state = { on: false, brightness: 0, hue: 0, saturation: 0, activePreset: -1 };
    this._ws = null;
    this._reconnectTimer = null;
    this._pendingHue = null;
    this._colorDebounce = null;
  }

  get capabilities() {
    const caps = ['power', 'brightness', 'color'];
    if (Object.keys(this.presetMap).length > 0) caps.push('preset');
    return caps;
  }

  async init() {
    // Retry a few times — WLED may still be booting when Hazel starts
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const { data: presets } = await axios.get(`http://${this.host}/presets.json`, { timeout: 5000 });
        for (const [id, preset] of Object.entries(presets)) {
          if (preset.n) {
            const numId = parseInt(id);
            this.presetMap[preset.n] = numId;
            this.idToPreset[numId] = preset.n;
          }
        }
        console.log(`[WLED:${this.name}] Loaded presets: ${Object.keys(this.presetMap).join(', ') || 'none'}`);

        const { data: state } = await axios.get(`http://${this.host}/json/state`, { timeout: 5000 });
        this._applyRaw(state);
        break;
      } catch {
        if (attempt < 3) {
          console.log(`[WLED:${this.name}] Unreachable, retrying in 5s (attempt ${attempt}/3)`);
          await new Promise(r => setTimeout(r, 5000));
        } else {
          console.log(`[WLED:${this.name}] Unreachable at startup, will sync via WebSocket when online`);
        }
      }
    }

    this._connectWs();
  }

  _connectWs() {
    this._ws = new WebSocket(`ws://${this.host}/ws`);

    this._ws.on('open', () => console.log(`[WLED:${this.name}] WebSocket connected`));

    this._ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.state) this._applyRaw(msg.state);
      } catch {}
    });

    this._ws.on('close', () => {
      console.log(`[WLED:${this.name}] WebSocket closed, reconnecting in 5s`);
      this._reconnectTimer = setTimeout(() => this._connectWs(), 5000);
    });

    this._ws.on('error', () => {});
  }

  _applyRaw(raw) {
    if (raw.on !== undefined) this.state.on = Boolean(raw.on);
    if (raw.bri !== undefined) this.state.brightness = Math.round(raw.bri / 2.55);
    if (raw.ps !== undefined) {
      this.state.activePreset = raw.ps;
      this.state.activePresetName = this.idToPreset[raw.ps] ?? null;
    }

    if (raw.seg && raw.seg[0] && raw.seg[0].col && raw.seg[0].col[0]) {
      const [r, g, b] = raw.seg[0].col[0];
      if (r || g || b) {
        const [h, s] = rgbToHsl(r, g, b);
        this.state.hue = h;
        this.state.saturation = s;
      }
    }

    this.emit('state', { ...this.state });
  }

  get(capability) {
    switch (capability) {
      case 'power':       return this.state.on;
      case 'brightness':  return this.state.brightness;
      case 'hue':         return this.state.hue;
      case 'saturation':  return this.state.saturation;
      case 'activePreset': return this.state.activePreset;
      default:            return null;
    }
  }

  getPresetId(name) {
    return this.presetMap[name] ?? -1;
  }

  async set(capability, value) {
    let body = {};

    switch (capability) {
      case 'power':
        body = { on: Boolean(value) };
        break;
      case 'brightness':
        body = { on: true, bri: Math.max(1, Math.round(value * 2.55)) };
        break;
      case 'hue':
        // Buffer hue changes — HomeKit sends hue and saturation as separate events
        this._pendingHue = value;
        clearTimeout(this._colorDebounce);
        this._colorDebounce = setTimeout(() => this._flushColor(), 80);
        return;
      case 'saturation':
        this.state.saturation = value;
        clearTimeout(this._colorDebounce);
        this._colorDebounce = setTimeout(() => this._flushColor(), 80);
        return;
      case 'color': {
        // Accept hex string (#rrggbb) from scenes/automations
        const r = parseInt(value.slice(1, 3), 16);
        const g = parseInt(value.slice(3, 5), 16);
        const b = parseInt(value.slice(5, 7), 16);
        body = { on: true, seg: [{ col: [[r, g, b]] }] };
        break;
      }
      case 'preset': {
        const id = this.presetMap[value];
        if (id === undefined) throw new Error(`Unknown preset: ${value}`);
        body = { ps: id, on: true };
        break;
      }
    }

    if (Object.keys(body).length) {
      try {
        await axios.post(`http://${this.host}/json/state`, body, { timeout: 3000 });
      } catch (e) {
        console.warn(`[WLED:${this.name}] Command failed (${e.code || e.message})`);
      }
    }
  }

  async _flushColor() {
    const h = this._pendingHue ?? this.state.hue;
    const s = this.state.saturation;
    const rgb = hslToRgb(h, s);
    this.state.hue = h;
    this._pendingHue = null;
    try {
      await axios.post(`http://${this.host}/json/state`, {
        on: true,
        seg: [{ col: [rgb] }]
      }, { timeout: 3000 });
    } catch (e) {
      console.warn(`[WLED:${this.name}] Color flush failed (${e.code || e.message})`);
    }
  }

  destroy() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._colorDebounce);
    if (this._ws) this._ws.terminate();
  }
}

module.exports = {
  name: 'wled',
  async init(config) {
    const driver = new WledDriver(config);
    await driver.init();
    return driver;
  }
};
