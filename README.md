<img src="hazel.png" alt="Hazel" width="120">

# Hazel — Matter Edition

> **This is a recode.** This repository is a ground-up rewrite of [Hazel](https://github.com/ArchiveHunter/hazel), replacing the HomeKit-only `hap-nodejs` bridge with a full **Matter** bridge via `@project-chip/matter-node.js`. A Matter bridge is natively understood by Apple Home, Google Home, and Amazon Alexa simultaneously — no separate integrations, no cloud accounts, one QR code to pair on all platforms.
>
> The plugin system, device registry, web UI, scenes, automations, and scheduler from the original Hazel are carried forward unchanged. Only the bridge layer is being rewritten.
>
> **Status: In development — not yet functional**

---

A custom Matter bridge built from scratch. The spiritual successor to the original HAP-only Hazel — same lean philosophy, same web UI, now speaking the open Matter standard instead of HomeKit's proprietary protocol.

**Built by [ArchiveHunter](https://github.com/ArchiveHunter) and Rowan**

---

## What it does

Hazel exposes your smart home devices to Apple HomeKit via the HAP (HomeKit Accessory Protocol). It runs as a single Node.js process, manages its own device polling and state, and provides a web UI for configuration, logging, and system management.

Devices are controlled through **plugins** — small drivers that know how to talk to a specific device type. Plugins can be enabled or disabled from the UI without touching config files.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Matter bridge | @project-chip/matter-node.js |
| Web UI | Express + EJS |
| Process manager | PM2 |
| mDNS | avahi-daemon |
| Config | YAML |

---

## Supported plugins

| Plugin | Protocol | Local | Cloud | Capabilities |
|---|---|---|---|---|
| **WLED** | HTTP + WebSocket | ✅ | — | power, brightness, colour, presets |
| **Tasmota** | HTTP REST | ✅ | — | power |
| **eWeLink** | Cloud API v2 | ⚠️ | ✅ | power (single + multi-channel) |
| **Shelly** | HTTP REST (Gen1) / WebSocket JSON-RPC (Gen2) | ✅ | — | power, brightness |
| **MQTT** | MQTT pub/sub | ✅ | — | configurable (power, temperature, humidity, …) |
| **Zigbee2MQTT** | MQTT (auto-discovers capabilities via Z2M) | ✅ | — | power, brightness, colour temp, temperature, humidity, contact, motion |
| **Daikin** | HTTP REST (legacy firmware only) | ✅ | — | power, temperature, target temperature, HVAC mode |

---

## Installation

### Prerequisites

- Node.js 20+
- PM2 (`npm install -g pm2`)
- avahi-daemon (`apt install avahi-daemon`)

```bash
git clone git@github.com:ArchiveHunter/hazel.git
cd hazel
npm install
cp config.example.yaml config.yaml
# Edit config.yaml with your devices and credentials
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### avahi-daemon

Hazel relies on avahi for mDNS advertisement so the Home app can discover the bridge. Without it, HomeKit pairing will fail silently.

```bash
sudo apt install avahi-daemon
sudo systemctl enable avahi-daemon
sudo systemctl start avahi-daemon
```

---

## Configuration

Copy `config.example.yaml` to `config.yaml` and edit it. The file is gitignored — your credentials stay local.

### Bridge

```yaml
bridge:
  name: Hazel
  username: "CC:22:3D:E3:CE:30"  # HAP bridge MAC — must be unique per bridge
  pin: "762-45-231"
  port: 51987
```

The `username` is the HAP bridge identifier. Change it if running multiple instances on the same network. The `pin` is used when pairing with the Home app.

### UI

```yaml
ui:
  port: 3088
```

### Plugin global settings

Only include sections for plugins you're using:

```yaml
ewelink:
  username: "your@email.com"
  password: "yourpassword"
  region: "eu"   # eu | us | as | cn

mqtt:
  broker: "mqtt://192.168.1.5"
  username: ""   # optional
  password: ""   # optional

zigbee2mqtt:
  broker: "mqtt://192.168.1.5"
  topic_prefix: "zigbee2mqtt"   # default
```

### Plugin enable/disable

```yaml
plugins:
  wled:         { enabled: true }
  tasmota:      { enabled: true }
  ewelink:      { enabled: true }
  shelly:       { enabled: false }
  mqtt:         { enabled: false }
  zigbee2mqtt:  { enabled: false }
  daikin:       { enabled: false }
```

This can also be toggled from the Plugins page in the web UI.

### Devices

```yaml
devices:
  - plugin: wled
    id: living-room-wall
    name: Living Room Wall
    host: 192.168.1.100
    presets:
      - Standard
      - Rainbow
      - Off

  - plugin: tasmota
    id: front-socket
    name: Front Socket
    host: 192.168.1.101

  - plugin: ewelink
    id: driveway-lights
    name: Driveway Lights
    device_id: "100278564d"

  # eWeLink multi-channel (TX2C) — one entry per channel
  - plugin: ewelink
    id: downlights
    name: Downlights
    device_id: "100102920d"
    channel: 0

  - plugin: ewelink
    id: pendants
    name: Pendants
    device_id: "100102920d"
    channel: 1

  - plugin: shelly
    id: hallway-dimmer
    name: Hallway Dimmer
    host: 192.168.1.102
    generation: auto   # auto | 1 | 2
    component: light   # relay | light | roller
    channel: 0

  - plugin: mqtt
    id: garden-sensor
    name: Garden Sensor
    topic_prefix: home/garden-sensor
    capabilities: temperature, humidity

  - plugin: zigbee2mqtt
    id: office-motion
    name: Office Motion
    device_name: office_motion_sensor   # Z2M friendly name

  - plugin: daikin
    id: living-room-ac
    name: Living Room AC
    host: 192.168.1.103
```

---

## Plugin details

### WLED

Connects via WebSocket for real-time state and HTTP for preset discovery. Presets listed in config appear as individual Switch accessories in HomeKit — mutually exclusive (selecting one turns off the others).

Find preset names in the WLED web UI under Presets.

### Tasmota

Polls `http://{host}/cm?cmnd=Power` every 5 seconds. Works with any single-relay Tasmota device.

### eWeLink

Uses the eWeLink cloud API (v2). Single-channel devices (MINIR4 etc.) and multi-channel devices (TX2C) are both supported. For multi-channel, add one config entry per channel with the same `device_id` and a `channel` field (0-based).

Device IDs are found in the eWeLink mobile app: tap the device → edit icon → scroll to Device ID.

LAN control (encrypted SonoffLAN protocol) is also supported if you provide `host` and `device_key` in the device config.

### Shelly

Auto-detects Gen1 vs Gen2 by probing the device. Gen1 uses HTTP REST polling; Gen2 uses a persistent WebSocket JSON-RPC connection with push notifications. Both generations support multi-channel — set `channel` to the outlet index (0-based).

### MQTT

Generic MQTT driver. State arrives as JSON on `{topic_prefix}/state`; commands are published as JSON to `{topic_prefix}/set`.

State JSON keys:
- `on` → power (boolean)
- `temperature` → °C (number)
- `humidity` → % (number)

Set `capabilities` in the device config as a comma-separated list to tell Hazel what HAP services to expose.

### Zigbee2MQTT

Connects to the same MQTT broker as Z2M. Capabilities are auto-discovered from `zigbee2mqtt/bridge/devices` — no manual capability list needed for known Z2M devices.

State topic: `zigbee2mqtt/{device_name}`
Command topic: `zigbee2mqtt/{device_name}/set`

Requires Zigbee2MQTT running with a compatible USB coordinator (CC2652, Sonoff Zigbee Dongle Plus, etc.).

### Daikin

Supports legacy Daikin WiFi adapters (BRP069Axx series) using the classic HTTP key-value API. **Do not update the firmware** — versions 2.8.0+ change the API entirely and are not supported.

Exposes a HomeKit Thermostat with current temperature, target temperature, and heating/cooling mode.

---

## Web UI

Access at `http://{host}:3088`

| Page | What it does |
|---|---|
| **Dashboard** | Live device state, power toggles, brightness sliders, colour picker, preset buttons |
| **Devices** | Add, edit, and remove devices. Shows live/pending status |
| **Plugins** | Enable/disable plugins, edit global credentials |
| **Logs** | Streaming log console with filter and pause |
| **System** | Bridge info, HomeKit PIN, live memory/CPU stats, Restart button |

Changes to device config take effect after a restart (System → Restart Hazel).

---

## HomeKit pairing

1. Open the **Home** app → tap **+** → **Add Accessory**
2. Choose **More options** if Hazel doesn't appear automatically
3. Enter PIN: as set in `config.yaml` (default in example: `031-45-154`)

All devices appear as accessories on the single Hazel bridge. Adding new devices only requires a Hazel restart — no re-pairing needed.

If you need to re-pair (e.g. after clearing the `persist/` directory):
1. Remove the Hazel bridge from Home → Home Settings → scroll to Hazel → Remove
2. Re-add with the PIN above

---

## Project structure

```
hazel/
├── hazel.js                  # Entry point
├── config.yaml               # Your config (gitignored)
├── config.example.yaml       # Template
├── ecosystem.config.js       # PM2 config
├── core/
│   ├── bridge.js             # HAP bridge wrapper
│   ├── registry.js           # Device registry + state
│   ├── device-builder.js     # HAP accessory construction
│   ├── config-manager.js     # Config CRUD + plugin schemas
│   ├── ui-server.js          # Express web server + API
│   ├── logger.js             # Console patch + SSE log stream
│   └── color.js              # RGB ↔ HSL helpers
├── plugins/
│   ├── wled/
│   ├── tasmota/
│   ├── ewelink/
│   ├── shelly/
│   ├── mqtt/
│   ├── zigbee2mqtt/
│   └── daikin/
└── ui/
    ├── views/                # EJS templates
    │   └── partials/
    └── public/
        ├── css/
        └── js/
```

---

## Writing a plugin

A plugin is a directory under `plugins/` with an `index.js` that exports a `name` string and an async `init(config, globalConfig)` function returning a driver.

```js
const { EventEmitter } = require('events');

class MyDriver extends EventEmitter {
  constructor(config, globalConfig) {
    super();
    this.name = config.name;
    this.state = { on: false };
  }

  get capabilities() {
    return ['power'];  // power | brightness | color | colorTemp | temperature | humidity | contact | motion | targetTemperature | hvacMode
  }

  async init() {
    // start polling or connect WebSocket
    // emit 'state' when state changes: this.emit('state', { ...this.state })
  }

  get(capability) {
    if (capability === 'power') return this.state.on;
    return null;
  }

  async set(capability, value) {
    if (capability === 'power') {
      // send command to device
      this.state.on = Boolean(value);
      this.emit('state', { ...this.state });
    }
  }

  destroy() {
    // clean up timers/connections
  }
}

module.exports = {
  name: 'myplugin',
  async init(config, globalConfig) {
    const driver = new MyDriver(config, globalConfig);
    await driver.init();
    return driver;
  },
};
```

Add the plugin schema to `core/config-manager.js` under `PLUGIN_SCHEMAS` and it will appear in the web UI automatically.

---

## Built with

- [@project-chip/matter-node.js](https://github.com/project-chip/matter.js) — Matter SDK for Node.js
- [Express](https://expressjs.com/) — Web UI server
- [js-yaml](https://github.com/nodeca/js-yaml) — Config parsing
- [axios](https://axios-http.com/) — HTTP device communication
- [ws](https://github.com/websockets/ws) — WebSocket (WLED, Shelly Gen2)
- [mqtt](https://github.com/mqttjs/MQTT.js) — MQTT (generic MQTT, Zigbee2MQTT)

---

*Hazel is a personal homelab project. It is not affiliated with Apple, Google, Amazon, or any device manufacturer.*
