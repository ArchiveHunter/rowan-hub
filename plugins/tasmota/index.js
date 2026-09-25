'use strict';

const axios = require('axios');
const { EventEmitter } = require('events');

class TasmotaDriver extends EventEmitter {
  constructor(config, mqttClient) {
    super();
    this.host    = config.host;
    this.name    = config.name;
    this.id      = config.id;
    this.channel = config.channel;
    this.mqttTopic = config.mqtt_topic || config.id; // override via mqtt_topic field
    this.state   = { on: false };
    this._mqtt   = mqttClient || null;
    this._pollTimer = null;
  }

  get capabilities() { return ['power']; }

  get _powerKey() {
    return this.channel !== undefined ? `POWER${this.channel}` : 'POWER';
  }

  async init() {
    if (this._mqtt) {
      await this._initMqtt();
    } else {
      await this._poll();
      this._pollTimer = setInterval(() => this._poll(), 5000);
    }
  }

  async _initMqtt() {
    const statTopic = `stat/${this.mqttTopic}/${this._powerKey}`;
    const teleTopic = `tele/${this.mqttTopic}/STATE`;

    this._mqtt.subscribe([statTopic, teleTopic], () => {});

    this._mqtt.on('message', (topic, payload) => {
      if (topic === statTopic) {
        this.state.on = payload.toString().toUpperCase() === 'ON';
        this.emit('state', { ...this.state });
      } else if (topic === teleTopic) {
        try {
          const data = JSON.parse(payload.toString());
          const val = data[this._powerKey];
          if (val !== undefined) {
            this.state.on = val.toUpperCase() === 'ON';
            this.emit('state', { ...this.state });
          }
        } catch {}
      }
    });

    // Seed current state via HTTP — broker hasn't received a publish yet
    await this._poll().catch(() => {});
  }

  async _poll() {
    try {
      const { data } = await axios.get(`http://${this.host}/cm`, {
        params: { cmnd: 'Power' },
        timeout: 3000,
      });
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
    if (this._mqtt) {
      this._mqtt.publish(`cmnd/${this.mqttTopic}/${this._powerKey}`, value ? 'ON' : 'OFF');
      this.state.on = Boolean(value);
      this.emit('state', { ...this.state });
    } else {
      const cmd = `${this._powerKey} ${value ? 'ON' : 'OFF'}`;
      try {
        await axios.get(`http://${this.host}/cm`, { params: { cmnd: cmd }, timeout: 3000 });
        this.state.on = Boolean(value);
        this.emit('state', { ...this.state });
      } catch (e) {
        console.warn(`[Tasmota:${this.name}] Command failed (${e.code || e.message})`);
      }
    }
  }

  destroy() {
    clearInterval(this._pollTimer);
  }
}

module.exports = {
  name: 'tasmota',
  async init(config, globalConfig, { mqttClient } = {}) {
    const driver = new TasmotaDriver(config, mqttClient);
    await driver.init();
    return driver;
  },
};
