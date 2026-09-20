const axios = require('axios');
const { EventEmitter } = require('events');

function parseKV(str) {
  const obj = {};
  str.split(',').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k && v !== undefined) obj[k.trim()] = v.trim();
  });
  return obj;
}

// Daikin mode → HAP CurrentHeatingCoolingState / TargetHeatingCoolingState
// 0=off, 1=heat, 2=cool, 3=auto
const DAIKIN_TO_HAP = { '0': 0, '1': 1, '2': 0, '3': 2, '4': 0, '6': 3 };
// HAP → Daikin mode (pow handled separately for off)
const HAP_TO_DAIKIN_MODE = { 0: '0', 1: '1', 2: '3', 3: '6' };

class DaikinDriver extends EventEmitter {
  constructor(config) {
    super();
    this.name = config.name;
    this.host = config.host;
    this.state = { on: false, temperature: 20, targetTemperature: 22, hvacMode: 0 };
    this._pollTimer = null;
  }

  get capabilities() {
    return ['power', 'temperature', 'targetTemperature', 'hvacMode'];
  }

  async init() {
    await this._poll();
    this._pollTimer = setInterval(() => this._poll().catch(() => {}), 30000);
  }

  async _poll() {
    const [ctrl, sensor] = await Promise.all([
      axios.get(`http://${this.host}/aircon/get_control_info`, { timeout: 5000 }),
      axios.get(`http://${this.host}/aircon/get_sensor_info`, { timeout: 5000 }),
    ]);
    const c = parseKV(ctrl.data);
    const s = parseKV(sensor.data);

    const on = c.pow === '1';
    const daikinMode = c.mode || '0';
    const hvacMode = on ? (DAIKIN_TO_HAP[daikinMode] ?? 0) : 0;
    const targetTemperature = parseFloat(c.stemp) || this.state.targetTemperature;
    const temperature = parseFloat(s.htemp) || this.state.temperature;

    this.state = { on, temperature, targetTemperature, hvacMode };
    this.emit('state', { ...this.state });
  }

  get(capability) {
    return this.state[capability];
  }

  async set(capability, value) {
    try {
      const { data } = await axios.get(`http://${this.host}/aircon/get_control_info`, { timeout: 5000 });
      const c = parseKV(data);

      if (capability === 'power') {
        c.pow = value ? '1' : '0';
      } else if (capability === 'hvacMode') {
        if (value === 0) {
          c.pow = '0';
        } else {
          c.pow = '1';
          c.mode = HAP_TO_DAIKIN_MODE[value] || '6';
        }
      } else if (capability === 'targetTemperature') {
        c.stemp = String(value);
      }

      const params = new URLSearchParams({
        pow:    c.pow   || '0',
        mode:   c.mode  || '6',
        stemp:  c.stemp || '22',
        shum:   c.shum  || '0',
        f_rate: c.f_rate || 'A',
        f_dir:  c.f_dir || '0',
      });

      await axios.get(`http://${this.host}/aircon/set_control_info?${params.toString()}`, { timeout: 5000 });
    } catch (e) {
      console.warn(`[Daikin:${this.name}] Command failed (${e.code || e.message})`);
    }
  }

  destroy() {
    clearInterval(this._pollTimer);
  }
}

module.exports = {
  name: 'daikin',
  async init(config) {
    const driver = new DaikinDriver(config);
    await driver.init();
    return driver;
  },
};
