const axios = require('axios');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const APP_ID = 'Uw83EKZFxdif7XFXEsrpduz5YyjP7nTl';
const APP_SECRET = 'mXLOjea0woSMvK9gw7Fjsy7YlFO4iSu6';

// ─── Shared cloud session (one per plugin type, shared across all eWeLink devices) ───

class EweLinkSession {
  constructor(credentials) {
    this.email = credentials.username;
    this.password = credentials.password;
    this.region = credentials.region || 'eu';
    this.httpHost = `${this.region}-apia.coolkit.cc`;
    this.aToken = null;
    this.subscribers = new Map(); // deviceId → EweLinkDriver[]
    this._pollTimer = null;
  }

  subscribe(deviceId, driver) {
    if (!this.subscribers.has(deviceId)) this.subscribers.set(deviceId, []);
    this.subscribers.get(deviceId).push(driver);
  }

  async login() {
    const body = { email: this.email, password: this.password, countryCode: '+44' };
    const sig = crypto.createHmac('sha256', APP_SECRET).update(JSON.stringify(body)).digest('base64');

    const { data } = await axios.post(`https://${this.httpHost}/v2/user/login`, body, {
      headers: {
        Authorization: `Sign ${sig}`,
        'Content-Type': 'application/json',
        'X-CK-Appid': APP_ID,
        'X-CK-Nonce': crypto.randomBytes(4).toString('hex'),
      },
      timeout: 15000,
    });

    if (data.error === 10004 && data.data?.region) {
      this.httpHost = `${data.data.region}-apia.coolkit.cc`;
      return this.login();
    }

    if (!data.data?.at) throw new Error(`eWeLink login failed: ${JSON.stringify(data)}`);

    this.aToken = data.data.at;
    this.apiKey = data.data.user.apikey;
    console.log(`[eWeLink] Logged in as ${this.email}`);
  }

  _headers() {
    return {
      Authorization: `Bearer ${this.aToken}`,
      'Content-Type': 'application/json',
      'X-CK-Appid': APP_ID,
      'X-CK-Nonce': crypto.randomBytes(4).toString('hex'),
    };
  }

  async fetchAllDevices() {
    const { data } = await axios.get(`https://${this.httpHost}/v2/device/thing`, {
      headers: this._headers(),
      timeout: 10000,
    });
    if (data.error === 401) throw new Error('eWeLink:401');
    const list = data.data?.thingList ?? [];
    // Build a map: deviceId → params
    const map = {};
    for (const thing of list) {
      if (thing.itemData?.deviceid) {
        map[thing.itemData.deviceid] = thing.itemData.params ?? {};
      }
    }
    return map;
  }

  async sendCommand(deviceId, params) {
    const res = await this._apiPost(`https://${this.httpHost}/v2/device/thing/status`, { type: 1, id: deviceId, params });
    if (res.error !== 0) throw new Error(`eWeLink command failed (${res.error}): ${res.msg || JSON.stringify(res)}`);
  }

  // POST with automatic token refresh on 401
  async _apiPost(url, body) {
    const { data } = await axios.post(url, body, { headers: this._headers(), timeout: 10000 });
    if (data.error === 401) {
      console.log('[eWeLink] Token expired, re-logging in…');
      await this.login();
      const { data: data2 } = await axios.post(url, body, { headers: this._headers(), timeout: 10000 });
      return data2;
    }
    return data;
  }

  startPolling() {
    this._pollAll(); // immediate first fetch
    this._pollTimer = setInterval(() => this._pollAll(), 5000);
  }

  async _pollAll() {
    try {
      const deviceMap = await this.fetchAllDevices();
      for (const [deviceId, drivers] of this.subscribers) {
        const params = deviceMap[deviceId];
        if (params) {
          for (const driver of drivers) driver.handleUpdate(params);
        }
      }
    } catch (e) {
      if (e.message === 'eWeLink:401') {
        console.log('[eWeLink] Token expired during poll, re-logging in…');
        try { await this.login(); } catch {}
      }
    }
  }

  destroy() {
    clearInterval(this._pollTimer);
  }
}

// ─── LAN control (SonoffLAN encrypted protocol) ───

function lanEncrypt(payload, deviceKey) {
  const key = crypto.createHash('md5').update(deviceKey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return { data: encrypted.toString('base64'), iv: iv.toString('base64') };
}

async function lanSend(host, deviceId, deviceKey, payload, endpoint = 'switch') {
  const { data, iv } = lanEncrypt(payload, deviceKey);
  await axios.post(`http://${host}:8081/zeroconf/${endpoint}`, {
    deviceid: deviceId,
    sequence: Date.now().toString(),
    selfApikey: '123',
    encrypt: true,
    data,
    iv,
  }, { timeout: 3000 });
}

async function lanGetState(host, deviceId, deviceKey) {
  const { data: encData, iv } = lanEncrypt({}, deviceKey);
  const { data: res } = await axios.post(`http://${host}:8081/zeroconf/info`, {
    deviceid: deviceId,
    sequence: Date.now().toString(),
    selfApikey: '123',
    encrypt: true,
    data: encData,
    iv,
  }, { timeout: 3000 });

  if (res.data) {
    const key = crypto.createHash('md5').update(deviceKey).digest();
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from(res.iv, 'base64'));
    const decrypted = Buffer.concat([decipher.update(res.data, 'base64'), decipher.final()]);
    return JSON.parse(decrypted.toString());
  }
  return null;
}

// ─── Per-device driver ───

class EweLinkDriver extends EventEmitter {
  constructor(config, session) {
    super();
    this.name = config.name;
    this.deviceId = config.device_id;
    this.channel = config.channel; // undefined = single-channel, 0/1 = TX2C channel
    this.mode = config.host ? 'lan' : 'cloud';
    this.host = config.host;
    this.deviceKey = config.device_key;
    this.session = session;
    this.state = { on: false };
    this._pollTimer = null;
  }

  get capabilities() {
    return ['power'];
  }

  async init() {
    if (this.mode === 'lan') {
      await this._lanPoll();
      this._pollTimer = setInterval(() => this._lanPoll(), 5000);
    }
    // Cloud initial state is fetched by the session's first poll — no extra call needed
  }

  async _lanPoll() {
    try {
      const payload = await lanGetState(this.host, this.deviceId, this.deviceKey);
      if (payload) this.handleUpdate(payload);
    } catch {}
  }

  // Outlet index this driver represents (0 for single-channel devices)
  get outlet() {
    return this.channel ?? 0;
  }

  handleUpdate(params) {
    // All eWeLink devices in this account use the switches[] array format
    let on;
    if (params.switches) {
      const sw = params.switches.find(s => s.outlet === this.outlet);
      if (sw) on = sw.switch === 'on';
    } else if (params.switch !== undefined) {
      on = params.switch === 'on';
    }
    if (on !== undefined) this.state.on = on;
    // Always emit so the registry can track lastSeen; registry deduplicates for SSE
    this.emit('state', { ...this.state });
  }

  get(capability) {
    if (capability === 'power') return this.state.on;
    return null;
  }

  _buildSwitches(on) {
    const siblings = this.session.subscribers.get(this.deviceId) || [];
    const hasMultiple = siblings.some(d => d.channel !== undefined);
    if (!hasMultiple) return [{ switch: on ? 'on' : 'off', outlet: 0 }];
    const maxChannel = Math.max(...siblings.map(d => d.channel ?? 0));
    return Array.from({ length: maxChannel + 1 }, (_, i) => {
      const sib = siblings.find(d => (d.channel ?? 0) === i);
      return { switch: i === this.outlet ? (on ? 'on' : 'off') : (sib?.state.on ? 'on' : 'off'), outlet: i };
    });
  }

  async set(capability, value) {
    if (capability !== 'power') return;
    const on = Boolean(value);

    if (this.mode === 'lan') {
      try {
        const switches = this._buildSwitches(on);
        await lanSend(this.host, this.deviceId, this.deviceKey, { switches }, 'switches');
      } catch (e) {
        console.warn(`[eWeLink:${this.name}] LAN unreachable (${e.code || e.message}), falling back to cloud`);
        await this.session.sendCommand(this.deviceId, { switches: this._buildSwitches(on) });
      }
    } else {
      await this.session.sendCommand(this.deviceId, { switches: this._buildSwitches(on) });
    }

    this.state.on = on;
    this.emit('state', { ...this.state });
  }

  destroy() {
    clearInterval(this._pollTimer);
  }
}

// ─── Plugin entry point ───

let _session = null;

module.exports = {
  name: 'ewelink',

  async init(config, globalConfig) {
    if (!_session) {
      if (!globalConfig?.username) throw new Error('eWeLink credentials missing from config (ewelink.username)');
      _session = new EweLinkSession(globalConfig);
      await _session.login();
      _session.startPolling();
    }

    const driver = new EweLinkDriver(config, _session);
    _session.subscribe(config.device_id, driver);
    await driver.init();
    return driver;
  },
};
