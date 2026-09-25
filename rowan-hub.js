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

  for (const deviceConfig of config.devices) {
    if (deviceConfig.enabled === false) {
      console.log(`[Rowan Hub] Skipping disabled device: ${deviceConfig.name}`);
      continue;
    }

    const pluginPath = path.join(__dirname, 'plugins', deviceConfig.plugin, 'index');
    let plugin;
    try {
      plugin = require(pluginPath);
    } catch {
      console.error(`[Rowan Hub] Plugin not found: ${deviceConfig.plugin}`);
      process.exit(1);
    }

    console.log(`[Rowan Hub] Initialising ${deviceConfig.plugin}: ${deviceConfig.name}`);

    const globalConfig = config[deviceConfig.plugin] || {};

    let driver;
    try {
      driver = await plugin.init(deviceConfig, globalConfig);
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

  registry.on('device-offline', ({ name }) => {
    pushManager.send('Device Offline', `${name} is not responding.`, { tag: `offline-${name}` });
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
