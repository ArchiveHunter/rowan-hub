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

class MqttDriver extends EventEmitter {
  constructor(config, globalConfig) {
    super();
    this.name = config.name;
    this._topicPrefix = config.topic_prefix;
    this._capabilities = normaliseCaps(config.capabilities);
    this._globalConfig = globalConfig || {};
    this.state = {};
    this._client = null;
  }

  get capabilities() {
    return this._capabilities;
  }

  async init() {
    this._client = getClient(this._globalConfig);
    this._client.subscribe(`${this._topicPrefix}/state`);
    this._client.on('message', (topic, payload) => {
      if (topic !== `${this._topicPrefix}/state`) return;
      try {
        this.handleUpdate(JSON.parse(payload.toString()));
      } catch {}
    });
  }

  handleUpdate(payload) {
    let changed = false;
    const next = { ...this.state };
    for (const [k, v] of Object.entries(payload)) {
      const key = k === 'on' ? 'power' : k;
      if (next[key] !== v) { next[key] = v; changed = true; }
    }
    if (changed) {
      this.state = next;
      this.emit('state', { ...this.state });
    }
  }

  get(capability) {
    return capability === 'power' ? this.state.power : this.state[capability];
  }

  async set(capability, value) {
    let msg;
    if (capability === 'power') {
      msg = { on: value };
    } else {
      msg = { [capability]: value };
    }
    this._client.publish(`${this._topicPrefix}/set`, JSON.stringify(msg));
  }

  destroy() {}
}

module.exports = {
  name: 'mqtt',
  async init(config, globalConfig) {
    const driver = new MqttDriver(config, globalConfig);
    await driver.init();
    return driver;
  },
};
