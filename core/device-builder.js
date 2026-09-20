const hap = require('hap-nodejs');
const { Accessory, Service, Characteristic, uuid } = hap;

function buildAccessories(config, driver) {
  const accessories = [];
  const caps = driver.capabilities || [];

  if (caps.includes('hvacMode') || caps.includes('targetTemperature')) {
    accessories.push(buildThermostatAccessory(config, driver, caps));
  } else if (!caps.includes('power') && caps.some(c => ['temperature', 'humidity', 'contact', 'motion'].includes(c))) {
    accessories.push(buildSensorAccessory(config, driver, caps));
  } else {
    const serviceType = caps.includes('brightness') ? Service.Lightbulb : Service.Switch;
    accessories.push(buildPrimaryAccessory(config, driver, serviceType, caps));

    if (Array.isArray(config.presets) && config.presets.length > 0) {
      const { presetAccs, presetSwitches } = buildPresetAccessories(config, driver);
      accessories.push(...presetAccs);

      driver.on('state', (state) => {
        for (const [name, sw] of presetSwitches) {
          const id = driver.getPresetId(name);
          sw.updateCharacteristic(Characteristic.On, state.activePreset === id);
        }
      });
    }
  }

  return accessories;
}

function buildPrimaryAccessory(config, driver, serviceType, caps) {
  const acc = new Accessory(config.name, uuid.generate(`hazel:device:${config.name}`));

  acc.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, 'Hazel')
    .setCharacteristic(Characteristic.Model, config.plugin.toUpperCase())
    .setCharacteristic(Characteristic.SerialNumber, config.host || config.device_id || config.name);

  const svc = acc.addService(serviceType, config.name);

  const logErr = (cap, e) => console.error(`[HomeKit:${config.name}] set ${cap} failed: ${e.message}`);

  svc.getCharacteristic(Characteristic.On)
    .on('get', cb => cb(null, Boolean(driver.get('power'))))
    .on('set', (val, cb) => { driver.set('power', val).catch(e => logErr('power', e)); cb(); });

  if (caps.includes('brightness')) {
    svc.getCharacteristic(Characteristic.Brightness)
      .on('get', cb => cb(null, driver.get('brightness') ?? 0))
      .on('set', (val, cb) => { driver.set('brightness', val).catch(e => logErr('brightness', e)); cb(); });
  }

  if (caps.includes('color')) {
    svc.getCharacteristic(Characteristic.Hue)
      .on('get', cb => cb(null, driver.get('hue') ?? 0))
      .on('set', (val, cb) => { driver.set('hue', val).catch(e => logErr('hue', e)); cb(); });

    svc.getCharacteristic(Characteristic.Saturation)
      .on('get', cb => cb(null, driver.get('saturation') ?? 0))
      .on('set', (val, cb) => { driver.set('saturation', val).catch(e => logErr('saturation', e)); cb(); });
  }

  if (caps.includes('colorTemp')) {
    svc.getCharacteristic(Characteristic.ColorTemperature)
      .on('get', cb => cb(null, driver.get('colorTemp') ?? 370))
      .on('set', (val, cb) => { driver.set('colorTemp', val).catch(e => logErr('colorTemp', e)); cb(); });
  }

  driver.on('state', (state) => {
    svc.updateCharacteristic(Characteristic.On, Boolean(state.on));
    if (caps.includes('brightness') && state.brightness !== undefined) {
      svc.updateCharacteristic(Characteristic.Brightness, state.brightness);
    }
    if (caps.includes('color')) {
      if (state.hue !== undefined) svc.updateCharacteristic(Characteristic.Hue, state.hue);
      if (state.saturation !== undefined) svc.updateCharacteristic(Characteristic.Saturation, state.saturation);
    }
    if (caps.includes('colorTemp') && state.colorTemp !== undefined) {
      svc.updateCharacteristic(Characteristic.ColorTemperature, state.colorTemp);
    }
  });

  return acc;
}

function buildThermostatAccessory(config, driver, caps) {
  const acc = new Accessory(config.name, uuid.generate(`hazel:device:${config.name}`));
  acc.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, 'Hazel')
    .setCharacteristic(Characteristic.Model, config.plugin.toUpperCase())
    .setCharacteristic(Characteristic.SerialNumber, config.host || config.device_id || config.name);

  const svc = acc.addService(Service.Thermostat, config.name);

  svc.getCharacteristic(Characteristic.CurrentTemperature)
    .on('get', cb => cb(null, driver.get('temperature') ?? 20));

  const logThermoErr = (cap, e) => console.error(`[HomeKit:${config.name}] set ${cap} failed: ${e.message}`);

  svc.getCharacteristic(Characteristic.TargetTemperature)
    .setProps({ minValue: 10, maxValue: 32, minStep: 0.5 })
    .on('get', cb => cb(null, driver.get('targetTemperature') ?? 22))
    .on('set', (val, cb) => { driver.set('targetTemperature', val).catch(e => logThermoErr('targetTemperature', e)); cb(); });

  svc.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .on('get', cb => cb(null, driver.get('hvacMode') ?? 0));

  svc.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .on('get', cb => cb(null, driver.get('hvacMode') ?? 0))
    .on('set', (val, cb) => { driver.set('hvacMode', val).catch(e => logThermoErr('hvacMode', e)); cb(); });

  svc.getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .on('get', cb => cb(null, 0));

  driver.on('state', state => {
    if (state.temperature !== undefined) svc.updateCharacteristic(Characteristic.CurrentTemperature, state.temperature);
    if (state.targetTemperature !== undefined) svc.updateCharacteristic(Characteristic.TargetTemperature, state.targetTemperature);
    if (state.hvacMode !== undefined) {
      svc.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, state.hvacMode);
      svc.updateCharacteristic(Characteristic.TargetHeatingCoolingState, state.hvacMode);
    }
  });

  return acc;
}

function buildSensorAccessory(config, driver, caps) {
  const acc = new Accessory(config.name, uuid.generate(`hazel:device:${config.name}`));
  acc.getService(Service.AccessoryInformation)
    .setCharacteristic(Characteristic.Manufacturer, 'Hazel')
    .setCharacteristic(Characteristic.Model, config.plugin.toUpperCase())
    .setCharacteristic(Characteristic.SerialNumber, config.host || config.device_name || config.name);

  if (caps.includes('temperature')) {
    const svc = acc.addService(Service.TemperatureSensor, config.name + ' Temperature');
    svc.getCharacteristic(Characteristic.CurrentTemperature)
      .on('get', cb => cb(null, driver.get('temperature') ?? 20));
    driver.on('state', state => {
      if (state.temperature !== undefined) svc.updateCharacteristic(Characteristic.CurrentTemperature, state.temperature);
    });
  }

  if (caps.includes('humidity')) {
    const svc = acc.addService(Service.HumiditySensor, config.name + ' Humidity');
    svc.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .on('get', cb => cb(null, driver.get('humidity') ?? 0));
    driver.on('state', state => {
      if (state.humidity !== undefined) svc.updateCharacteristic(Characteristic.CurrentRelativeHumidity, state.humidity);
    });
  }

  if (caps.includes('contact')) {
    const svc = acc.addService(Service.ContactSensor, config.name + ' Contact');
    svc.getCharacteristic(Characteristic.ContactSensorState)
      .on('get', cb => cb(null, driver.get('contact') === false ? 1 : 0));
    driver.on('state', state => {
      if (state.contact !== undefined) svc.updateCharacteristic(Characteristic.ContactSensorState, state.contact === false ? 1 : 0);
    });
  }

  if (caps.includes('motion')) {
    const svc = acc.addService(Service.MotionSensor, config.name + ' Motion');
    svc.getCharacteristic(Characteristic.MotionDetected)
      .on('get', cb => cb(null, Boolean(driver.get('motion'))));
    driver.on('state', state => {
      if (state.motion !== undefined) svc.updateCharacteristic(Characteristic.MotionDetected, Boolean(state.motion));
    });
  }

  return acc;
}

function buildPresetAccessories(config, driver) {
  const presetAccs = [];
  const presetSwitches = new Map();

  for (const presetName of config.presets) {
    const label = `${config.name} — ${presetName}`;
    const acc = new Accessory(label, uuid.generate(`hazel:preset:${config.name}:${presetName}`));

    acc.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Hazel')
      .setCharacteristic(Characteristic.Model, 'Preset')
      .setCharacteristic(Characteristic.SerialNumber, `${config.name}-${presetName}`);

    const sw = acc.addService(Service.Switch, label);
    presetSwitches.set(presetName, sw);
    presetAccs.push(acc);
  }

  for (const [presetName, sw] of presetSwitches) {
    const logPresetErr = (cap, e) => console.error(`[HomeKit:${config.name}] set ${cap} failed: ${e.message}`);
    sw.getCharacteristic(Characteristic.On)
      .on('get', cb => {
        const active = driver.get('activePreset');
        const id = driver.getPresetId(presetName);
        cb(null, id >= 0 && active === id);
      })
      .on('set', (val, cb) => {
        if (val) {
          driver.set('preset', presetName).catch(e => logPresetErr('preset', e));
          for (const [name, other] of presetSwitches) {
            if (name !== presetName) other.updateCharacteristic(Characteristic.On, false);
          }
        } else {
          const active = driver.get('activePreset');
          const id = driver.getPresetId(presetName);
          if (id >= 0 && active === id) driver.set('power', false).catch(e => logPresetErr('power', e));
        }
        cb();
      });
  }

  return { presetAccs, presetSwitches };
}

module.exports = { buildAccessories };
