const mqtt = require('mqtt');
const { EventEmitter } = require('events');

const _clients = new Map();

function getClient(globalConfig) {
  const url = globalConfig.broker;
  if (!_clients.has(url)) {
    const client = mqtt.connect(url, {
      username: globalConfig.username || undefined,
      password: globalConfig.password || undefined,
    });
    _clients.set(url, client);
  }
  return _clients.get(url);
}

function normaliseCaps(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(c => c.trim()).filter(Boolean);
  return String(raw).split(',').map(c => c.trim()).filter(Boolean);
}

// Map a Z2M expose entry to a capability name
function exposeToCapability(expose) {
  const n = expose.name;
  const t = expose.type;
  if (n === 'state' && t === 'binary') return 'power';
  if (n === 'brightness' && t === 'numeric') return 'brightness';
  if (n === 'color_temp' && t === 'numeric') return 'colorTemp';
  if (n === 'temperature' && t === 'numeric') return 'temperature';
  if (n === 'humidity' && t === 'numeric') return 'humidity';
  if (n === 'contact' && t === 'binary') return 'contact';
  if ((n === 'occupancy' || n === 'motion') && t === 'binary') return 'motion';
  return null;
}

function parseCapsFromExposes(exposes) {
  if (!Array.isArray(exposes)) return [];
  const caps = [];
  for (const e of exposes) {
    if (e.features) {
      for (const f of e.features) {
        const c = exposeToCapability(f);
        if (c && !caps.includes(c)) caps.push(c);
      }
    } else {
      const c = exposeToCapability(e);
      if (c && !caps.includes(c)) caps.push(c);
    }
  }
  return caps;
}

class Zigbee2MqttDriver extends EventEmitter {
  constructor(config, globalConfig) {
    super();
    this.name = config.name;
    this._deviceName = config.device_name;
    this._globalConfig = globalConfig || {};
    const prefix = (globalConfig && globalConfig.topic_prefix) || 'zigbee2mqtt';
    this._stateTopic = `${prefix}/${this._deviceName}`;
    this._setTopic = `${prefix}/${this._deviceName}/set`;
    this._bridgeTopic = `${prefix}/bridge/devices`;
    this._fallbackCaps = normaliseCaps(config.capabilities);
    this._capabilities = [];
    this.state = {};
    this._client = null;
  }

  get capabilities() {
    return this._capabilities.length ? this._capabilities : this._fallbackCaps;
  }

  async init() {
    this._client = getClient(this._globalConfig);
    this._client.subscribe(this._stateTopic);
    this._client.subscribe(this._bridgeTopic);

    // Wait up to 3s for bridge/devices to learn capabilities
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      const handler = (topic, payload) => {
        if (topic !== this._bridgeTopic) return;
        try {
          const devices = JSON.parse(payload.toString());
          const entry = devices.find(d => d.friendly_name === this._deviceName);
          if (entry && entry.definition && entry.definition.exposes) {
            this._capabilities = parseCapsFromExposes(entry.definition.exposes);
          }
        } catch {}
        clearTimeout(timer);
        this._client.removeListener('message', handler);
        resolve();
      };
      this._client.on('message', handler);
    });

    if (!this._capabilities.length) {
      this._capabilities = this._fallbackCaps;
    }

    this._client.on('message', (topic, payload) => {
      if (topic !== this._stateTopic) return;
      try {
        this.handleUpdate(JSON.parse(payload.toString()));
      } catch {}
    });

    // Request current state
    this._client.publish(`${this._stateTopic}/get`, JSON.stringify({ state: '' }));
  }

  handleUpdate(payload) {
    let changed = false;
    const prev = { ...this.state };
    const next = { ...this.state };

    if (payload.state !== undefined) {
      const on = payload.state === 'ON';
      if (next.power !== on) { next.power = on; changed = true; }
    }
    if (payload.brightness !== undefined) {
      const b = Math.round(payload.brightness / 2.54);
      if (next.brightness !== b) { next.brightness = b; changed = true; }
    }
    if (payload.color_temp !== undefined) {
      if (next.colorTemp !== payload.color_temp) { next.colorTemp = payload.color_temp; changed = true; }
    }
    if (payload.temperature !== undefined) {
      if (next.temperature !== payload.temperature) { next.temperature = payload.temperature; changed = true; }
    }
    if (payload.humidity !== undefined) {
      if (next.humidity !== payload.humidity) { next.humidity = payload.humidity; changed = true; }
    }
    if (payload.contact !== undefined) {
      if (next.contact !== payload.contact) { next.contact = payload.contact; changed = true; }
    }
    if (payload.occupancy !== undefined) {
      if (next.motion !== payload.occupancy) { next.motion = payload.occupancy; changed = true; }
    }

    if (changed) {
      this.state = next;
      this.emit('state', { ...this.state });
    }
  }

  get(capability) {
    return this.state[capability];
  }

  async set(capability, value) {
    let msg;
    switch (capability) {
      case 'power':       msg = { state: value ? 'ON' : 'OFF' }; break;
      case 'brightness':  msg = { brightness: Math.round(value * 2.54) }; break;
      case 'colorTemp':   msg = { color_temp: value }; break;
      default:            msg = { [capability]: value };
    }
    this._client.publish(this._setTopic, JSON.stringify(msg));
  }

  destroy() {}
}

module.exports = {
  name: 'zigbee2mqtt',
  async init(config, globalConfig) {
    const driver = new Zigbee2MqttDriver(config, globalConfig);
    await driver.init();
    return driver;
  },
};
