require('@matter/main/platform');

const path = require('path');
const { Endpoint, Environment, ServerNode, VendorId } = require('@matter/main');
const { AggregatorEndpoint } = require('@matter/main/endpoints/aggregator');
const { BridgedDeviceBasicInformationServer } = require('@matter/main/behaviors/bridged-device-basic-information');
const { OnOffPlugInUnitDevice } = require('@matter/main/devices/on-off-plug-in-unit');
const { buildEndpoints } = require('./device-builder');

class HazelBridge {
  constructor(config) {
    this.config = config;
    this._server = null;
    this._aggregator = null;
    this._deviceEndpoints = new Map(); // deviceId → Endpoint[]
  }

  async init() {
    // Store matter.js persistence alongside the project
    Environment.default.vars.set('storage.path', path.join(__dirname, '..', 'matter-storage'));

    const uniqueId = 'hazel-bridge';

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
        name: this.config.name || 'Hazel',
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorName: 'Hazel',
        vendorId: VendorId(0xfff1),
        nodeLabel: this.config.name || 'Hazel',
        productName: 'Hazel Matter Bridge',
        productLabel: 'Hazel',
        productId: 0x8000,
        serialNumber: uniqueId,
        uniqueId,
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
    console.log(`[Hazel] Registered: ${names}`);
  }

  async removeDevice(deviceId) {
    const endpoints = this._deviceEndpoints.get(deviceId);
    if (!endpoints) return;
    for (const ep of endpoints) {
      try { await ep.close(); } catch {}
    }
    this._deviceEndpoints.delete(deviceId);
    console.log(`[Hazel] Removed from Matter: ${deviceId}`);
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
          serialNumber: `hazel-scene-${scene.id}`,
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

    console.log(`[Hazel] Registered scene: ${scene.name}`);
  }

  async start() {
    await this._server.start();
    const port = this.config.port || 5540;
    const passcode = this.config.passcode || 20202021;
    const discriminator = this.config.discriminator || 3840;
    console.log(`[Hazel] Matter bridge started on port ${port}`);
    console.log(`[Hazel] Passcode: ${passcode} · Discriminator: ${discriminator}`);
    console.log(`[Hazel] QR code printed above — scan with Home / Google Home / Alexa app`);
  }

  getCommissioningInfo() {
    return {
      passcode: this.config.passcode || 20202021,
      discriminator: this.config.discriminator || 3840,
      port: this.config.port || 5540,
      commissioned: this._server?.lifecycle?.isCommissioned ?? false,
    };
  }
}

module.exports = { HazelBridge };
