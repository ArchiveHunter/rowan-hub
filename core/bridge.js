require('@matter/main/platform');

const path = require('path');
const { Endpoint, Environment, ServerNode, VendorId } = require('@matter/main');
const { AggregatorEndpoint } = require('@matter/main/endpoints/aggregator');
const { BridgedDeviceBasicInformationServer } = require('@matter/main/behaviors/bridged-device-basic-information');
const { OnOffPlugInUnitDevice } = require('@matter/main/devices/on-off-plug-in-unit');
const { DeviceCommissioner } = require('@matter/protocol');
const { buildEndpoints } = require('./device-builder');

class RowanHubBridge {
  constructor(config) {
    this.config = config;
    this._server = null;
    this._aggregator = null;
    this._deviceEndpoints = new Map(); // deviceId → Endpoint[]
    this._windowOpen = false;
  }

  async init() {
    Environment.default.vars.set('storage.path', path.join(__dirname, '..', 'matter-storage'));

    const uniqueId = 'hazel-bridge'; // kept for continuity — changing would wipe commissioning

    this._server = await ServerNode.create({
      id: uniqueId,
      network: {
        port: this.config.port || 5540,
      },
      commissioning: {
        passcode: this.config.passcode || 20202021,
        discriminator: this.config.discriminator || 3840,
      },
      productDescription: {
        name: this.config.name || 'Rowan Hub',
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorName: 'Rowan Hub',
        vendorId: VendorId(0xfff1),
        nodeLabel: this.config.name || 'Rowan Hub',
        productName: 'Rowan Hub Matter Bridge',
        productLabel: 'Matter Bridge',
        productId: 0x8000,
        serialNumber: 'rowan-hub-bridge',
        uniqueId,
        hardwareVersion: 1,
        hardwareVersionString: '1',
        softwareVersion: 11,
        softwareVersionString: require('../package.json').version,
      },
    });

    this._aggregator = new Endpoint(AggregatorEndpoint, { id: 'aggregator' });
    await this._server.add(this._aggregator);
  }

  async addDevice(deviceConfig, driver) {
    const endpoints = buildEndpoints(deviceConfig, driver);
    for (const ep of endpoints) {
      await this._aggregator.add(ep);
    }
    this._deviceEndpoints.set(deviceConfig.id, endpoints);
    const names = endpoints.map(e => e.id).join(', ');
    console.log(`[Rowan Hub] Registered: ${names}`);
  }

  async removeDevice(deviceId) {
    const endpoints = this._deviceEndpoints.get(deviceId);
    if (!endpoints) return;
    for (const ep of endpoints) {
      try { await ep.close(); } catch {}
    }
    this._deviceEndpoints.delete(deviceId);
    console.log(`[Rowan Hub] Removed from Matter: ${deviceId}`);
  }

  async addScene(scene, registry) {
    const endpoint = new Endpoint(
      OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: `scene-${scene.id}`,
        bridgedDeviceBasicInformation: {
          nodeLabel: scene.name,
          productName: scene.name,
          productLabel: scene.name,
          serialNumber: `rowan-scene-${scene.id}`.slice(0, 32),
          reachable: true,
        },
      }
    );
    await this._aggregator.add(endpoint);

    let triggering = false;
    endpoint.events.onOff.onOff$Changed.on(async value => {
      if (!value || triggering) return;
      triggering = true;
      try {
        for (const action of scene.actions) {
          await registry.set(action.device, action.capability, action.value);
        }
      } finally {}
      setTimeout(async () => {
        try { await endpoint.set({ onOff: { onOff: false } }); } catch {}
        triggering = false;
      }, 1000);
    });

    console.log(`[Rowan Hub] Registered scene: ${scene.name}`);
  }

  async start() {
    await this._server.start();
    const port = this.config.port || 5540;
    const passcode = this.config.passcode || 20202021;
    const discriminator = this.config.discriminator || 3840;
    console.log(`[Rowan Hub] Matter bridge started on port ${port}`);
    console.log(`[Rowan Hub] Passcode: ${passcode} · Discriminator: ${discriminator}`);
    console.log(`[Rowan Hub] QR code printed above — scan with Home / Google Home / Alexa app`);
  }

  async openCommissioningWindow() {
    const commissioner = this._server.env.get(DeviceCommissioner);
    this._windowOpen = true;
    await commissioner.allowBasicCommissioning(() => {
      this._windowOpen = false;
    });
  }

  getCommissioningInfo() {
    let qrPairingCode = null;
    try {
      qrPairingCode = this._server?.state?.commissioning?.pairingCodes?.qrPairingCode ?? null;
    } catch {}
    return {
      passcode: this.config.passcode || 20202021,
      discriminator: this.config.discriminator || 3840,
      port: this.config.port || 5540,
      commissioned: this._server?.lifecycle?.isCommissioned ?? false,
      qrPairingCode,
      windowStatus: this._windowOpen ? 2 : 0,
    };
  }
}

module.exports = { RowanHubBridge };
