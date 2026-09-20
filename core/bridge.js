const hap = require('hap-nodejs');
const { Bridge, Accessory, Service, Characteristic, uuid, Categories, HAPStorage } = hap;
const path = require('path');
const { buildAccessories } = require('./device-builder');

class HazelBridge {
  constructor(config) {
    this.config = config;

    HAPStorage.setCustomStoragePath(path.join(__dirname, '..', 'persist'));

    this._bridge = new Bridge(config.name || 'Hazel', uuid.generate(`hazel:bridge:${config.name}`));

    this._bridge.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Hazel')
      .setCharacteristic(Characteristic.Model, 'Bridge')
      .setCharacteristic(Characteristic.SerialNumber, config.username || '00:00:00:00:00:00');

    this._deviceAccessories = new Map(); // deviceId → Accessory[]
  }

  addDevice(deviceConfig, driver) {
    const accessories = buildAccessories(deviceConfig, driver);
    for (const acc of accessories) {
      this._bridge.addBridgedAccessory(acc);
    }
    this._deviceAccessories.set(deviceConfig.id, accessories);
    const names = accessories.map(a => a.displayName).join(', ');
    console.log(`[Hazel] Registered: ${names}`);
  }

  removeDevice(deviceId) {
    const accs = this._deviceAccessories.get(deviceId);
    if (!accs) return;
    for (const acc of accs) {
      try { this._bridge.removeBridgedAccessory(acc); } catch {}
    }
    this._deviceAccessories.delete(deviceId);
    console.log(`[Hazel] Removed from HomeKit: ${deviceId}`);
  }

  addScene(scene, registry) {
    const acc = new Accessory(scene.name, uuid.generate(`hazel:scene:${scene.id}`));

    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Hazel')
      .setCharacteristic(Characteristic.Model, 'Scene')
      .setCharacteristic(Characteristic.SerialNumber, scene.id);

    const sw = acc.addService(Service.Switch, scene.name);

    sw.getCharacteristic(Characteristic.On)
      .on('get', cb => cb(null, false))
      .on('set', (val, cb) => {
        cb();
        if (!val) return;
        (async () => {
          for (const action of scene.actions) {
            await registry.set(action.device, action.capability, action.value);
          }
        })().catch(console.error);
        // Auto-reset to off so it behaves like a button
        setTimeout(() => sw.updateCharacteristic(Characteristic.On, false), 1000);
      });

    this._bridge.addBridgedAccessory(acc);
    console.log(`[Hazel] Registered scene: ${scene.name}`);
  }

  start() {
    const publishOpts = {
      username: this.config.username,
      pincode: this.config.pin,
      port: this.config.port || 51987,
      category: Categories.BRIDGE,
    };
    // Bind to a specific IP when the machine has multiple interfaces (tailscale, docker, etc.)
    if (this.config.bind) publishOpts.bind = this.config.bind;

    this._bridge.publish(publishOpts);

    console.log(`[Hazel] Bridge "${this.config.name}" started on port ${publishOpts.port}`);
    console.log(`[Hazel] Add to HomeKit with PIN: ${this.config.pin}`);
  }

  getSetupURI() {
    try { return this._bridge.setupURI(); } catch { return null; }
  }
}

module.exports = { HazelBridge };
