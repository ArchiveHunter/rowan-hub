<img src="hazel.png" alt="Hazel" width="120">

# Hazel

A custom Matter bridge built from scratch. Runs as a single Node.js process, manages smart home devices across multiple protocols, and exposes them to any Matter-compatible platform — Apple Home, Google Home, and Amazon Alexa — simultaneously, with one commissioning scan.

**Built by [ArchiveHunter](https://github.com/ArchiveHunter) and Rowan**

> This is a recode of the original [Hazel](https://github.com/ArchiveHunter/hazel). The bridge layer has been rewritten around the open Matter standard. The plugin system, device registry, web UI, scenes, automations, and scheduler are carried forward unchanged.

---

## What it does

Hazel exposes your smart home devices to any Matter-compatible platform. It runs locally, handles its own device polling and state management, and provides a web UI for configuration, logging, and system management.

Devices are controlled through **plugins** — small drivers that know how to talk to a specific device type. Plugins can be enabled or disabled from the UI without touching config files. Individual devices can also be enabled or disabled independently, so you can configure devices in advance and activate them when needed.

---

## Why Matter

Matter is the open smart home standard backed by Apple, Google, Amazon, Samsung, and the Connectivity Standards Alliance. A Matter bridge:

- **Pairs once** — one QR code scan works for all platforms at the same time
- **Runs locally** — no cloud dependency for device control
- **No skill certification** — works in Alexa without publishing an Alexa skill
- **No integration config** — Google Home and Apple Home discover the bridge natively

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20+ |
| Matter bridge | @matter/main 0.17.x |
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
| **eWeLink** | Cloud API v2 + LAN | ⚠️ | ✅ | power (single + multi-channel) |
| **Shelly** | HTTP REST (Gen1) / WebSocket JSON-RPC (Gen2) | ✅ | — | power, brightness |
| **MQTT** | MQTT pub/sub | ✅ | — | configurable (power, temperature, humidity, …) |
| **Zigbee2MQTT** | MQTT (auto-discovers capabilities via Z2M) | ✅ | — | power, brightness, colour temp, temperature, humidity, contact, motion |
| **Daikin** | HTTP REST (legacy firmware only) | ✅ | — | power, temperature, target temperature, HVAC mode |

---

## Capability → Matter device type

Hazel maps plugin capabilities to Matter device types automatically:

| Capabilities | Matter device type |
|---|---|
| power | On/Off Plug-in Unit |
| power + brightness | Dimmable Light |
| power + brightness + color | Extended Color Light (HS + colour temperature) |
| power + brightness + colorTemp | Color Temperature Light |
| temperature (sensor only) | Temperature Sensor |
| humidity (sensor only) | Humidity Sensor |
| contact | Contact Sensor |
| motion | Occupancy Sensor |
| hvacMode / targetTemperature | On/Off switch (full Thermostat cluster — TODO) |
| WLED presets | One On/Off switch per preset |

---

## Installation

### Prerequisites

- Node.js 20+
- PM2 (`npm install -g pm2`)
- avahi-daemon (`apt install avahi-daemon`)

```bash
git clone git@github.com:ArchiveHunter/hazel-matter.git
cd hazel-matter
npm install
cp config.example.yaml config.yaml
# Edit config.yaml with your bridge settings, devices, and credentials
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

### avahi-daemon

Hazel relies on avahi for mDNS so Matter controllers can discover the bridge on the local network. Without it, commissioning will fail.

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
  passcode: 20202021   # 8-digit pairing code — choose any number (avoid 11111111, 22222222, etc.)
  discriminator: 3840  # 0–4095, used for mDNS discovery; change if running multiple bridges on the same network
  port: 5540           # Matter UDP port (default 5540; must be unique per bridge on the host)
```

`passcode` is the code you enter (or that the QR code encodes) when commissioning with a platform. `discriminator` distinguishes this bridge from others during discovery. Neither needs to change after commissioning unless you reset the bridge.

### UI

```yaml
ui:
  port: 3088
```

### Plugin global settings

Only include sections for plugins you actually use:

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
  # WLED LED strip — presets appear as individual switches
  - plugin: wled
    id: living-room-wall
    name: Living Room Wall
    host: 192.168.1.100
    presets:
      - Standard
      - Rainbow
      - Off

  # Tasmota smart plug
  - plugin: tasmota
    id: front-socket
    name: Front Socket
    host: 192.168.1.101

  # eWeLink single-channel (MINIR4 etc.)
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

  # Shelly relay (Gen1 or Gen2 — auto-detected)
  - plugin: shelly
    id: hallway-dimmer
    name: Hallway Dimmer
    host: 192.168.1.102
    generation: auto   # auto | 1 | 2
    component: light   # relay | light | roller
    channel: 0

  # Generic MQTT device
  - plugin: mqtt
    id: garden-sensor
    name: Garden Sensor
    topic_prefix: home/garden-sensor
    capabilities: temperature, humidity

  # Zigbee2MQTT device
  - plugin: zigbee2mqtt
    id: office-motion
    name: Office Motion
    device_name: office_motion_sensor   # Z2M friendly name

  # Daikin AC (legacy firmware only)
  - plugin: daikin
    id: living-room-ac
    name: Living Room AC
    host: 192.168.1.103
```

#### Disabling individual devices

Any device can be disabled without removing it from the config:

```yaml
  - plugin: tasmota
    id: christmas-tree
    name: Christmas Tree
    host: 192.168.1.110
    enabled: false   # skipped at startup; not visible to any platform
```

Disabled devices can be toggled on or off from the Devices page in the web UI. Enabling takes effect immediately without a restart.

---

## Plugin details

### WLED

Connects via WebSocket for real-time state and HTTP for preset discovery. Presets listed in config appear as individual switches — mutually exclusive (selecting one turns off the others).

Find preset names in the WLED web UI under Presets.

### Tasmota

Polls `http://{host}/cm?cmnd=Power` every 5 seconds. Works with any single-relay Tasmota device.

Multi-gang devices are supported — add one entry per channel, set `channel: 1`, `channel: 2`, etc.

### eWeLink

Uses the eWeLink cloud API (v2). Single-channel devices (MINIR4 etc.) and multi-channel devices (TX2C) are both supported. For multi-channel, add one config entry per channel with the same `device_id` and a `channel` field (0-based).

Device IDs are in the eWeLink app: tap the device → edit icon → scroll to Device ID.

LAN control is supported if you provide `host` and `device_key`. Commands go via LAN first; if the device is unreachable it falls back to cloud and logs a one-line warning.

### Shelly

Auto-detects Gen1 vs Gen2 by probing the device. Gen1 uses HTTP REST polling; Gen2 uses a persistent WebSocket JSON-RPC connection with push notifications. Both support multi-channel — set `channel` to the outlet index (0-based).

### MQTT

Generic MQTT driver. State arrives as JSON on `{topic_prefix}/state`; commands are published as JSON to `{topic_prefix}/set`.

State JSON keys:
- `on` → power (boolean)
- `temperature` → °C (number)
- `humidity` → % (number)

Set `capabilities` in the device config as a comma-separated list to tell Hazel what Matter device types to expose.

### Zigbee2MQTT

Connects to the same MQTT broker as Z2M. Capabilities are auto-discovered from `zigbee2mqtt/bridge/devices` — no manual capability list needed for known Z2M devices.

State topic: `zigbee2mqtt/{device_name}`
Command topic: `zigbee2mqtt/{device_name}/set`

Requires Zigbee2MQTT running with a compatible USB coordinator (CC2652, Sonoff Zigbee Dongle Plus, etc.).

### Daikin

Supports legacy Daikin WiFi adapters (BRP069Axx series) using the classic HTTP key-value API. **Do not update the firmware** — versions 2.8.0+ change the API entirely and are not supported.

Exposes a switch representing HVAC on/off. Full thermostat cluster support (target temperature, mode) is planned for a later iteration.

---

## Web UI

Access at `http://{host}:3088`

| Page | What it does |
|---|---|
| **Dashboard** | Live device state, power toggles, brightness sliders, colour picker, preset buttons |
| **Devices** | Add, edit, remove, and enable/disable devices |
| **Plugins** | Enable/disable plugins, edit global credentials |
| **Scenes** | Create named scenes; scenes appear as switches on all paired platforms |
| **Automations** | Time-based and sunrise/sunset automation rules |
| **Logs** | Streaming log console |
| **System** | Bridge commissioning info, passcode, live stats, Restart button |

---

## Commissioning

When Hazel starts for the first time (or after a commission reset), it prints a QR code to the log output. Scan it with any compatible app to pair:

| Platform | App |
|---|---|
| Apple | Home app — tap + → Add Accessory |
| Google | Google Home app — tap + → Set up device → Matter |
| Amazon | Alexa app — Devices → + → Add Device → Matter |

All three can be commissioned from the same QR code — scan once per platform.

If you can't scan the QR code, you can enter the passcode manually:
1. Open the commissioning flow in your app
2. Choose "Enter code manually" or similar
3. Enter the 8-digit passcode from `config.yaml`

### Commission state

Commissioning data is stored in `matter-storage/` alongside the project. This directory is gitignored. Do not delete it while the bridge is commissioned — you would need to re-pair all platforms.

### Re-commissioning

To start fresh (wipe all paired platforms and commission again):
1. Delete the `matter-storage/` directory
2. Restart Hazel — a new QR code will be printed to the logs
3. Re-scan with each platform

---

## Project structure

```
hazel-matter/
├── hazel.js                  # Entry point
├── config.yaml               # Your config (gitignored)
├── config.example.yaml       # Template
├── ecosystem.config.js       # PM2 config
├── matter-storage/           # Commissioning state (gitignored — do not delete while paired)
├── core/
│   ├── bridge.js             # Matter bridge (ServerNode + AggregatorEndpoint)
│   ├── registry.js           # Device registry + state
│   ├── device-builder.js     # Matter endpoint construction
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

A plugin is a directory under `plugins/` with an `index.js` that exports an async `init(config, globalConfig)` function returning a driver.

```js
const { EventEmitter } = require('events');

class MyDriver extends EventEmitter {
  constructor(config, globalConfig) {
    super();
    this.state = { on: false };
  }

  get capabilities() {
    // power | brightness | color | colorTemp
    // temperature | humidity | contact | motion
    // targetTemperature | hvacMode
    return ['power'];
  }

  get(capability) {
    if (capability === 'power') return this.state.on;
    return null;
  }

  async set(capability, value) {
    if (capability === 'power') {
      this.state.on = Boolean(value);
      // send command to device here
      this.emit('state', { ...this.state });
    }
  }

  destroy() {
    // clean up timers / connections
  }
}

module.exports = {
  async init(config, globalConfig) {
    const driver = new MyDriver(config, globalConfig);
    // start polling or connect WebSocket here
    return driver;
  },
};
```

The driver emits `'state'` whenever device state changes. Hazel syncs that state to the Matter endpoint automatically. Conversely, when a Matter controller changes a device's state, Hazel calls `driver.set()`.

Add the plugin schema to `core/config-manager.js` under `PLUGIN_SCHEMAS` and it will appear in the web UI's add/edit device forms automatically.

---

## Built with

- [@matter/main](https://github.com/project-chip/matter.js) — Matter SDK for Node.js
- [Express](https://expressjs.com/) — Web UI server
- [js-yaml](https://github.com/nodeca/js-yaml) — Config parsing
- [axios](https://axios-http.com/) — HTTP device communication
- [ws](https://github.com/websockets/ws) — WebSocket (WLED, Shelly Gen2)
- [mqtt](https://github.com/mqttjs/MQTT.js) — MQTT (generic MQTT, Zigbee2MQTT)
- [suncalc](https://github.com/mourner/suncalc) — Sunrise/sunset times for automations

---

*Hazel is a personal homelab project. It is not affiliated with Apple, Google, Amazon, or any device manufacturer.*
