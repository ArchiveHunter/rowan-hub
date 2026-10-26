require('./core/logger'); // patch console.* before anything else logs
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { RowanHubBridge } = require('./core/bridge');
const { Registry } = require('./core/registry');
const { startUiServer } = require('./core/ui-server');
const Scheduler = require('./core/scheduler');
const scenesManager = require('./core/scenes-manager');
const pushManager = require('./core/push-manager');
const mqttBroker = require('./core/mqtt-broker');
const configManager = require('./core/config-manager');

async function main() {
  const configPath = path.join(__dirname, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    console.error('[Rowan Hub] config.yaml not found');
    process.exit(1);
  }

  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

  const registry = new Registry();
  const bridge = new RowanHubBridge(config.bridge);

  try {
    await bridge.init();
  } catch (e) {
    console.error(`[Rowan Hub] Bridge init failed: ${e.message}`);
    process.exit(1);
  }

  // Start internal MQTT broker if enabled in config, then create shared client
  let mqttClient = null;
  if (config.mqtt_broker?.enabled) {
    try {
      await mqttBroker.start();
      mqttClient = mqttBroker.createClient();
      await new Promise((resolve, reject) => {
        mqttClient.once('connect', resolve);
        mqttClient.once('error', reject);
        setTimeout(() => reject(new Error('MQTT connect timeout')), 8000);
      });
      console.log('[Rowan Hub] MQTT broker running — MQTT mode active');
    } catch (e) {
      console.warn(`[Rowan Hub] MQTT broker unavailable: ${e.message} — falling back to polling`);
      if (mqttClient) { mqttClient.end(true); mqttClient = null; }
    }
  }

  for (const deviceConfig of config.devices) {
    if (deviceConfig.enabled === false) {
      console.log(`[Rowan Hub] Skipping disabled device: ${deviceConfig.name}`);
      continue;
    }

    let plugin;
    try {
      plugin = require(configManager.pluginPath(deviceConfig.plugin));
    } catch {
      console.error(`[Rowan Hub] Plugin not found: ${deviceConfig.plugin}`);
      process.exit(1);
    }

    console.log(`[Rowan Hub] Initialising ${deviceConfig.plugin}: ${deviceConfig.name}`);

    const globalConfig = config[deviceConfig.plugin] || {};

    let driver;
    try {
      driver = await plugin.init(deviceConfig, globalConfig, { mqttClient });
    } catch (e) {
      console.error(`[Rowan Hub] Failed to init ${deviceConfig.name}: ${e.message}`);
      process.exit(1);
    }

    if (!deviceConfig.id) {
      deviceConfig.id = deviceConfig.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    }

    registry.register(deviceConfig.id, deviceConfig, driver);
    await bridge.addDevice(deviceConfig, driver);
  }

  for (const scene of scenesManager.getAll()) {
    await bridge.addScene(scene, registry);
  }

  try {
    await bridge.start();
  } catch (e) {
    console.error(`[Rowan Hub] Bridge start failed: ${e.message}`);
    process.exit(1);
  }

  const scheduler = new Scheduler(registry, config.location);
  scheduler.start();

  // Registry marks a device offline after 2 min of silence; only notify if it is still
  // offline 3 min later, so brief drops (e.g. WLED WebSocket reconnects) don't alert.
  const OFFLINE_GRACE_MS = 3 * 60 * 1000;
  const offlineTimers = new Map();
  registry.on('device-offline', ({ id, name }) => {
    clearTimeout(offlineTimers.get(id));
    offlineTimers.set(id, setTimeout(() => {
      offlineTimers.delete(id);
      if (!registry.get(id)) return; // disabled/removed in the meantime
      pushManager.send('Device Offline', `${name} is not responding.`, { tag: `offline-${name}` });
    }, OFFLINE_GRACE_MS));
  });
  registry.on('device-online', ({ id }) => {
    clearTimeout(offlineTimers.get(id));
    offlineTimers.delete(id);
  });

  scheduler.on('fired', ({ name }) => {
    pushManager.send('Automation Ran', `"${name}" completed successfully.`, { tag: `auto-${name}` });
  });

  pushManager.startUpdateChecks();

  startUiServer(registry, config.ui || {}, scheduler, bridge);
}

main().catch(err => {
  console.error('[Rowan Hub] Fatal:', err.message);
  process.exit(1);
});
