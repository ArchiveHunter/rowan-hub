'use strict';

const { Endpoint } = require('@matter/main');
const { BridgedDeviceBasicInformationServer } = require('@matter/main/behaviors/bridged-device-basic-information');
const { ColorControlServer } = require('@matter/main/behaviors/color-control');
const { OnOffPlugInUnitDevice } = require('@matter/main/devices/on-off-plug-in-unit');
const { DimmableLightDevice } = require('@matter/main/devices/dimmable-light');
const { ExtendedColorLightDevice } = require('@matter/main/devices/extended-color-light');
const { ColorTemperatureLightDevice } = require('@matter/main/devices/color-temperature-light');
const { ContactSensorDevice } = require('@matter/main/devices/contact-sensor');
const { OccupancySensorDevice } = require('@matter/main/devices/occupancy-sensor');
const { TemperatureSensorDevice } = require('@matter/main/devices/temperature-sensor');
const { HumiditySensorDevice } = require('@matter/main/devices/humidity-sensor');

// Extended color light that supports hue/saturation mode (for HSV drivers like WLED)
const HsColorLightDevice = ExtendedColorLightDevice.with(
  ColorControlServer.with('HueSaturation', 'ColorTemperature')
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function bridgeInfo(config, label) {
  const name = label || config.name;
  return {
    nodeLabel: name,
    productName: name,
    productLabel: name,
    serialNumber: `hazel-${config.id}`,
    reachable: true,
  };
}

function logErr(name, cap, e) {
  console.error(`[Matter:${name}] set ${cap} failed: ${e.message}`);
}

// ── Entry point ───────────────────────────────────────────────────────────────

function buildEndpoints(deviceConfig, driver) {
  const caps = driver.capabilities || [];

  if (caps.includes('hvacMode') || caps.includes('targetTemperature')) {
    return [buildThermostatEndpoint(deviceConfig, driver)];
  }

  if (!caps.includes('power') && caps.some(c => ['temperature', 'humidity', 'contact', 'motion'].includes(c))) {
    return buildSensorEndpoints(deviceConfig, driver, caps);
  }

  const endpoints = [buildLightOrSwitchEndpoint(deviceConfig, driver, caps)];

  if (Array.isArray(deviceConfig.presets) && deviceConfig.presets.length > 0) {
    for (const preset of deviceConfig.presets) {
      endpoints.push(buildPresetEndpoint(deviceConfig, driver, preset));
    }
  }

  return endpoints;
}

// ── Light / switch endpoint ───────────────────────────────────────────────────

function buildLightOrSwitchEndpoint(deviceConfig, driver, caps) {
  const hasBrightness = caps.includes('brightness');
  const hasColor      = caps.includes('color');
  const hasColorTemp  = caps.includes('colorTemp');
  const name          = deviceConfig.name;

  let DeviceBase;
  if (hasBrightness && hasColor) {
    DeviceBase = HsColorLightDevice;
  } else if (hasBrightness && hasColorTemp) {
    DeviceBase = ColorTemperatureLightDevice;
  } else if (hasBrightness) {
    DeviceBase = DimmableLightDevice;
  } else {
    DeviceBase = OnOffPlugInUnitDevice;
  }

  const endpoint = new Endpoint(DeviceBase.with(BridgedDeviceBasicInformationServer), {
    id: deviceConfig.id,
    bridgedDeviceBasicInformation: bridgeInfo(deviceConfig),
  });

  let syncing = false;

  // ── Matter → driver ────────────────────────────────────────────────────────

  endpoint.events.onOff.onOff$Changed.on(async value => {
    if (syncing) return;
    driver.set('power', value).catch(e => logErr(name, 'power', e));
  });

  if (hasBrightness) {
    endpoint.events.levelControl.currentLevel$Changed.on(async value => {
      if (syncing || value == null) return;
      // Matter level: 1–254 → Hazel brightness: 0–100
      driver.set('brightness', Math.round(value * 100 / 254)).catch(e => logErr(name, 'brightness', e));
    });
  }

  if (hasColor) {
    endpoint.events.colorControl.currentHue$Changed.on(async value => {
      if (syncing || value == null) return;
      // Matter hue: 0–254 → degrees: 0–360
      driver.set('hue', Math.round(value * 360 / 254)).catch(e => logErr(name, 'hue', e));
    });
    endpoint.events.colorControl.currentSaturation$Changed.on(async value => {
      if (syncing || value == null) return;
      // Matter saturation: 0–254 → percent: 0–100
      driver.set('saturation', Math.round(value * 100 / 254)).catch(e => logErr(name, 'saturation', e));
    });
  }

  if (hasColorTemp) {
    endpoint.events.colorControl.colorTemperatureMireds$Changed.on(async value => {
      if (syncing || value == null) return;
      driver.set('colorTemp', value).catch(e => logErr(name, 'colorTemp', e));
    });
  }

  // ── driver → Matter ────────────────────────────────────────────────────────

  driver.on('state', async state => {
    syncing = true;
    try {
      const updates = {};

      if (state.on !== undefined) {
        updates.onOff = { onOff: Boolean(state.on) };
      }

      if (hasBrightness && state.brightness !== undefined) {
        // Hazel brightness: 0–100 → Matter level: 1–254
        updates.levelControl = { currentLevel: Math.max(1, Math.round(state.brightness * 254 / 100)) };
      }

      if (hasColor) {
        const cc = {};
        if (state.hue !== undefined)        cc.currentHue        = Math.round(state.hue * 254 / 360);
        if (state.saturation !== undefined) cc.currentSaturation = Math.round(state.saturation * 254 / 100);
        if (Object.keys(cc).length)         updates.colorControl = cc;
      }

      if (hasColorTemp && state.colorTemp !== undefined) {
        updates.colorControl = { ...(updates.colorControl || {}), colorTemperatureMireds: state.colorTemp };
      }

      if (Object.keys(updates).length) await endpoint.set(updates);
    } catch (e) {
      console.warn(`[Matter:${name}] state sync failed: ${e.message}`);
    } finally {
      syncing = false;
    }
  });

  return endpoint;
}

// ── Sensor endpoints ──────────────────────────────────────────────────────────

function buildSensorEndpoints(deviceConfig, driver, caps) {
  const endpoints = [];

  if (caps.includes('temperature')) {
    const ep = new Endpoint(
      TemperatureSensorDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: `${deviceConfig.id}-temp`,
        bridgedDeviceBasicInformation: bridgeInfo(deviceConfig, `${deviceConfig.name} Temperature`),
        temperatureMeasurement: { measuredValue: 2000 }, // default 20°C
      }
    );
    driver.on('state', async state => {
      if (state.temperature !== undefined) {
        // Hazel: °C → Matter: 0.01°C
        try { await ep.set({ temperatureMeasurement: { measuredValue: Math.round(state.temperature * 100) } }); } catch {}
      }
    });
    endpoints.push(ep);
  }

  if (caps.includes('humidity')) {
    const ep = new Endpoint(
      HumiditySensorDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: `${deviceConfig.id}-humidity`,
        bridgedDeviceBasicInformation: bridgeInfo(deviceConfig, `${deviceConfig.name} Humidity`),
        relativeHumidityMeasurement: { measuredValue: 5000 }, // default 50%
      }
    );
    driver.on('state', async state => {
      if (state.humidity !== undefined) {
        // Hazel: % → Matter: 0.01%
        try { await ep.set({ relativeHumidityMeasurement: { measuredValue: Math.round(state.humidity * 100) } }); } catch {}
      }
    });
    endpoints.push(ep);
  }

  if (caps.includes('contact')) {
    const ep = new Endpoint(
      ContactSensorDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: `${deviceConfig.id}-contact`,
        bridgedDeviceBasicInformation: bridgeInfo(deviceConfig, `${deviceConfig.name} Contact`),
        booleanState: { stateValue: true }, // true = closed/normal
      }
    );
    driver.on('state', async state => {
      if (state.contact !== undefined) {
        // contact: false = open/alarm → stateValue: false
        try { await ep.set({ booleanState: { stateValue: state.contact !== false } }); } catch {}
      }
    });
    endpoints.push(ep);
  }

  if (caps.includes('motion')) {
    const ep = new Endpoint(
      OccupancySensorDevice.with(BridgedDeviceBasicInformationServer),
      {
        id: `${deviceConfig.id}-motion`,
        bridgedDeviceBasicInformation: bridgeInfo(deviceConfig, `${deviceConfig.name} Motion`),
        occupancySensing: { occupancy: { occupied: false } },
      }
    );
    driver.on('state', async state => {
      if (state.motion !== undefined) {
        try { await ep.set({ occupancySensing: { occupancy: { occupied: Boolean(state.motion) } } }); } catch {}
      }
    });
    endpoints.push(ep);
  }

  return endpoints;
}

// ── Thermostat endpoint ───────────────────────────────────────────────────────

function buildThermostatEndpoint(deviceConfig, driver) {
  // TODO: implement full Matter Thermostat cluster (complex mandatory attribute set).
  // For now, map HVAC on/off to a simple switch — replace with ThermostatDevice in a later iteration.
  const name = deviceConfig.name;

  const endpoint = new Endpoint(
    OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
    {
      id: deviceConfig.id,
      bridgedDeviceBasicInformation: bridgeInfo(deviceConfig),
    }
  );

  let syncing = false;

  endpoint.events.onOff.onOff$Changed.on(async value => {
    if (syncing) return;
    driver.set('hvacMode', value ? 1 : 0).catch(e => logErr(name, 'hvacMode', e));
  });

  driver.on('state', async state => {
    syncing = true;
    try {
      if (state.hvacMode !== undefined) {
        await endpoint.set({ onOff: { onOff: state.hvacMode !== 0 } });
      }
    } catch (e) {
      console.warn(`[Matter:${name}] state sync failed: ${e.message}`);
    } finally {
      syncing = false;
    }
  });

  return endpoint;
}

// ── Preset switch endpoints (WLED) ────────────────────────────────────────────

function buildPresetEndpoint(deviceConfig, driver, presetName) {
  const slug = presetName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const id    = `${deviceConfig.id}-preset-${slug}`;
  const label = `${deviceConfig.name} — ${presetName}`;

  const endpoint = new Endpoint(
    OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer),
    {
      id,
      bridgedDeviceBasicInformation: {
        nodeLabel: label,
        productName: label,
        productLabel: label,
        serialNumber: `hazel-${id}`,
        reachable: true,
      },
    }
  );

  endpoint.events.onOff.onOff$Changed.on(async value => {
    if (value) {
      driver.set('preset', presetName).catch(e => logErr(label, 'preset', e));
    } else {
      const active  = driver.get('activePreset');
      const presetId = driver.getPresetId(presetName);
      if (presetId >= 0 && active === presetId) {
        driver.set('power', false).catch(e => logErr(label, 'power', e));
      }
    }
  });

  // Reflect active preset state back to the switch
  driver.on('state', async state => {
    if (state.activePreset !== undefined) {
      const presetId = driver.getPresetId(presetName);
      const isActive = presetId >= 0 && state.activePreset === presetId;
      try { await endpoint.set({ onOff: { onOff: isActive } }); } catch {}
    }
  });

  return endpoint;
}

module.exports = { buildEndpoints };
