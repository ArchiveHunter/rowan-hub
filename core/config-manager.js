const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_PATH = path.join(__dirname, '..', 'config.yaml');

const PLUGIN_SCHEMAS = {
  wled: {
    label: 'WLED LED Strip',
    color: '#6B5CE7',
    defaultEnabled: true,
    fields: [
      { name: 'name',    label: 'Device Name', type: 'text',   required: true },
      { name: 'host',    label: 'IP Address',  type: 'text',   required: true, placeholder: '192.168.1.100' },
      { name: 'presets', label: 'Presets',     type: 'tags',   hint: 'Comma-separated names of saved presets on the device' },
    ],
  },
  tasmota: {
    label: 'Tasmota',
    color: '#10b981',
    defaultEnabled: true,
    fields: [
      { name: 'name',       label: 'Device Name', type: 'text',   required: true },
      { name: 'host',       label: 'IP Address',  type: 'text',   required: true },
      { name: 'channel',    label: 'Channel',     type: 'number', placeholder: 'Leave empty for single-relay' },
      { name: 'mqtt_topic', label: 'MQTT Topic',  type: 'text',   placeholder: 'Leave blank — uses device ID' },
    ],
  },
  ewelink: {
    label: 'eWeLink / Sonoff',
    color: '#3b82f6',
    defaultEnabled: true,
    fields: [
      { name: 'name',       label: 'Device Name',                type: 'text',   required: true },
      { name: 'device_id',  label: 'Device ID',                  type: 'text',   required: true },
      { name: 'channel',    label: 'Channel',                    type: 'number', placeholder: 'Leave empty for single-channel' },
      { name: 'host',       label: 'LAN IP',                     type: 'text',   placeholder: 'Optional — enables direct LAN control' },
      { name: 'device_key', label: 'LAN Device Key',             type: 'text',   placeholder: 'Required if LAN IP is set' },
    ],
    globalFields: [
      { name: 'username', label: 'eWeLink Email',    type: 'text',     required: true },
      { name: 'password', label: 'eWeLink Password', type: 'password', required: true },
      { name: 'region',   label: 'Region',           type: 'select',   options: ['eu', 'us', 'as', 'cn'], required: true },
    ],
  },
  shelly: {
    label: 'Shelly',
    color: '#e8534a',
    defaultEnabled: false,
    fields: [
      { name: 'name',       label: 'Device Name',   type: 'text',   required: true },
      { name: 'host',       label: 'IP Address',    type: 'text',   required: true },
      { name: 'generation', label: 'Generation',    type: 'select', options: ['auto', '1', '2'], required: true },
      { name: 'component',  label: 'Component',     type: 'select', options: ['relay', 'light', 'roller'] },
      { name: 'channel',    label: 'Channel',       type: 'number', placeholder: '0' },
      { name: 'mqtt_id',    label: 'MQTT Device ID', type: 'text',  placeholder: 'e.g. shelly1-AABBCC (from device Settings → Device Info)' },
    ],
  },
  mqtt: {
    label: 'MQTT',
    color: '#9b59b6',
    defaultEnabled: false,
    fields: [
      { name: 'name',         label: 'Device Name',  type: 'text', required: true },
      { name: 'topic_prefix', label: 'Topic Prefix', type: 'text', required: true, placeholder: 'home/my-device' },
      { name: 'capabilities', label: 'Capabilities', type: 'tags', placeholder: 'power, temperature, humidity' },
    ],
    globalFields: [
      { name: 'broker',   label: 'Broker URL', type: 'text',     required: true, placeholder: 'mqtt://192.168.1.5' },
      { name: 'username', label: 'Username',   type: 'text' },
      { name: 'password', label: 'Password',   type: 'password' },
    ],
  },
  zigbee2mqtt: {
    label: 'Zigbee2MQTT',
    color: '#27ae60',
    defaultEnabled: false,
    fields: [
      { name: 'name',        label: 'Device Name',       type: 'text', required: true },
      { name: 'device_name', label: 'Z2M Friendly Name', type: 'text', required: true, placeholder: 'living_room_sensor' },
    ],
    globalFields: [
      { name: 'broker',       label: 'Broker URL',   type: 'text',     required: true, placeholder: 'mqtt://192.168.1.5' },
      { name: 'username',     label: 'Username',     type: 'text' },
      { name: 'password',     label: 'Password',     type: 'password' },
      { name: 'topic_prefix', label: 'Topic Prefix', type: 'text',     placeholder: 'zigbee2mqtt' },
    ],
  },
  daikin: {
    label: 'Daikin',
    color: '#2980b9',
    defaultEnabled: false,
    fields: [
      { name: 'name', label: 'Device Name', type: 'text', required: true },
      { name: 'host', label: 'IP Address',  type: 'text', required: true },
    ],
  },
};

function load() {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function save(config) {
  const backup = CONFIG_PATH + '.bak';
  if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, backup);
  fs.writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: 120 }), 'utf8');
}

function addDevice(deviceConfig) {
  const config = load();
  if (!deviceConfig.id) {
    deviceConfig.id = deviceConfig.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  }
  if (config.devices.some(d => d.id === deviceConfig.id)) {
    throw new Error(`Device ID "${deviceConfig.id}" already exists`);
  }
  config.devices.push(deviceConfig);
  save(config);
  return deviceConfig;
}

function updateDevice(id, updates) {
  const config = load();
  const idx = config.devices.findIndex(d => d.id === id);
  if (idx === -1) throw new Error(`Device "${id}" not found`);
  config.devices[idx] = { ...config.devices[idx], ...updates, id };
  save(config);
  return config.devices[idx];
}

function removeDevice(id) {
  const config = load();
  const before = config.devices.length;
  config.devices = config.devices.filter(d => d.id !== id);
  if (config.devices.length === before) throw new Error(`Device "${id}" not found`);
  save(config);
}

function toggleDevice(id, enabled) {
  const config = load();
  const idx = config.devices.findIndex(d => d.id === id);
  if (idx === -1) throw new Error(`Device "${id}" not found`);
  if (enabled) {
    delete config.devices[idx].enabled;
  } else {
    config.devices[idx].enabled = false;
  }
  save(config);
  return config.devices[idx];
}

function updatePluginGlobal(pluginName, values) {
  const config = load();
  config[pluginName] = { ...(config[pluginName] || {}), ...values };
  save(config);
}

function togglePlugin(name, enabled) {
  const config = load();
  if (!config.plugins) config.plugins = {};
  config.plugins[name] = { ...(config.plugins[name] || {}), enabled };
  save(config);
}

function getPlugins() {
  const config = load();
  const installed = Object.keys(PLUGIN_SCHEMAS).map(name => {
    const schema = PLUGIN_SCHEMAS[name];
    const pluginEntry = config.plugins && config.plugins[name];
    const enabled = pluginEntry && pluginEntry.enabled !== undefined
      ? pluginEntry.enabled
      : (schema.defaultEnabled !== false);
    return {
      name,
      ...schema,
      enabled,
      globalConfig: config[name] || null,
      deviceCount: config.devices.filter(d => d.plugin === name).length,
    };
  });
  return installed;
}

function getEnabledPluginNames() {
  return getPlugins().filter(p => p.enabled).map(p => p.name);
}

function getSchemas() {
  return PLUGIN_SCHEMAS;
}

function updateLocation(latitude, longitude) {
  const config = load();
  config.location = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };
  save(config);
}

function getMqttBrokerEnabled() {
  try { return load().mqtt_broker?.enabled === true; } catch { return false; }
}

function setMqttBrokerEnabled(enabled) {
  const config = load();
  config.mqtt_broker = { ...(config.mqtt_broker || {}), enabled: Boolean(enabled) };
  save(config);
}

function isSetupComplete() {
  try { return load().setup_complete === true; } catch { return false; }
}

function completeSetup({ bridgeName, passcode, discriminator, latitude, longitude }) {
  const config = load();
  config.bridge = {
    ...config.bridge,
    name: bridgeName || 'Rowan Hub',
    passcode: parseInt(passcode, 10) || 20202021,
    discriminator: parseInt(discriminator, 10) ?? 3840,
  };
  config.location = { latitude: parseFloat(latitude), longitude: parseFloat(longitude) };
  config.devices = [];
  config.setup_complete = true;
  save(config);
}

module.exports = { load, save, addDevice, updateDevice, removeDevice, toggleDevice, updatePluginGlobal, togglePlugin, getPlugins, getEnabledPluginNames, getSchemas, updateLocation, isSetupComplete, completeSetup, getMqttBrokerEnabled, setMqttBrokerEnabled };
