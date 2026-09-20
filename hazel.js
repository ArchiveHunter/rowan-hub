require('./core/logger'); // patch console.* before anything else logs
const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');
const { HazelBridge } = require('./core/bridge');
const { Registry } = require('./core/registry');
const { startUiServer } = require('./core/ui-server');
const Scheduler = require('./core/scheduler');
const scenesManager = require('./core/scenes-manager');

async function main() {
  const configPath = path.join(__dirname, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    console.error('[Hazel] config.yaml not found');
    process.exit(1);
  }

  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));

  const registry = new Registry();
  const bridge = new HazelBridge(config.bridge);

  for (const deviceConfig of config.devices) {
    if (deviceConfig.enabled === false) {
      console.log(`[Hazel] Skipping disabled device: ${deviceConfig.name}`);
      continue;
    }

    const pluginPath = path.join(__dirname, 'plugins', deviceConfig.plugin, 'index');
    let plugin;
    try {
      plugin = require(pluginPath);
    } catch {
      console.error(`[Hazel] Plugin not found: ${deviceConfig.plugin}`);
      process.exit(1);
    }

    console.log(`[Hazel] Initialising ${deviceConfig.plugin}: ${deviceConfig.name}`);

    // Pass the plugin's global config section (e.g. config.ewelink for ewelink devices)
    const globalConfig = config[deviceConfig.plugin] || {};

    let driver;
    try {
      driver = await plugin.init(deviceConfig, globalConfig);
    } catch (e) {
      console.error(`[Hazel] Failed to init ${deviceConfig.name}: ${e.message}`);
      process.exit(1);
    }

    // Ensure every device has an id — write it back to config if missing
    if (!deviceConfig.id) {
      deviceConfig.id = deviceConfig.name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    }
    registry.register(deviceConfig.id, deviceConfig, driver);
    bridge.addDevice(deviceConfig, driver);
  }

  // Expose scenes as HomeKit switches (tap = trigger, auto-resets to off)
  for (const scene of scenesManager.getAll()) {
    bridge.addScene(scene, registry);
  }

  bridge.start();

  const scheduler = new Scheduler(registry, config.location);
  scheduler.start();

  startUiServer(registry, config.ui || {}, scheduler, bridge);
}

main().catch(err => {
  console.error('[Hazel] Fatal:', err.message);
  process.exit(1);
});
