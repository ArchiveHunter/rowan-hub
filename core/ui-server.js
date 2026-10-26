const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');
const logger = require('./logger');
const configManager = require('./config-manager');
const automationsManager = require('./automations-manager');
const scenesManager = require('./scenes-manager');
const pushManager = require('./push-manager');
const mqttBroker = require('./mqtt-broker');
const auth = require('./auth');
const describe = require('./describe');
const { version } = require('../package.json');

const CERT_PATH = path.join(__dirname, '..', 'rowan-hub-cert.pem');
const KEY_PATH  = path.join(__dirname, '..', 'rowan-hub-key.pem');

async function loadOrGenerateCert() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  }
  console.log('[Rowan Hub] Generating self-signed TLS certificate…');
  const attrs = [{ name: 'commonName', value: 'rowanhub.local' }];
  const opts  = { days: 3650, keySize: 2048 };
  const pems  = await selfsigned.generate(attrs, opts);
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH,  pems.private, { mode: 0o600 });
  return { cert: pems.cert, key: pems.private };
}

const startTime = Date.now();

function capabilitiesFromConfig(deviceCfg) {
  switch (deviceCfg.plugin) {
    case 'tasmota':
    case 'ewelink':
      return ['power'];
    case 'wled': {
      const caps = ['power', 'brightness', 'color'];
      if (deviceCfg.presets?.length) caps.push('preset');
      return caps;
    }
    case 'shelly':
      return deviceCfg.component === 'light' ? ['power', 'brightness'] : ['power'];
    case 'daikin':
      return ['power', 'hvacMode', 'targetTemperature'];
    case 'mqtt':
      return (deviceCfg.capabilities || '').split(',').map(c => c.trim()).filter(Boolean);
    default:
      return ['power'];
  }
}

// Returns all devices for UI dropdowns: enabled (from registry) + disabled (from config).
function allDevicesForUI(registry) {
  const registryDevices = registry.getAll().map(d => ({
    id: d.id, name: d.name, capabilities: d.capabilities, presets: d.presets || [],
  }));
  const registryIds = new Set(registryDevices.map(d => d.id));
  const cfg = configManager.load();
  const disabledDevices = (cfg.devices || [])
    .filter(d => d.enabled === false && !registryIds.has(d.id))
    .map(d => ({
      id: d.id,
      name: `${d.name} (disabled)`,
      capabilities: capabilitiesFromConfig(d),
      presets: d.presets || [],
    }));
  return [...registryDevices, ...disabledDevices];
}

async function startUiServer(registry, config, scheduler, bridge) {
  const app = express();
  const port = config.port || 3088;

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'ui', 'views'));
  app.locals.version = version;
  app.locals.describe = describe;

  // Name lookup for every configured device (enabled or not) — used to describe scenes/automations
  function deviceDirectory() {
    const cfg = configManager.load();
    const names = {}, disabled = [];
    for (const d of cfg.devices || []) {
      names[d.id] = d.name;
      if (d.enabled === false) disabled.push(d.id);
    }
    return { names, disabled };
  }

  async function pairingInfo() {
    const info = bridge ? bridge.getCommissioningInfo() : null;
    let qrDataUrl = null;
    if (info?.qrPairingCode) {
      try { qrDataUrl = await QRCode.toDataURL(info.qrPairingCode, { width: 220, margin: 1, color: { dark: '#000', light: '#fff' } }); } catch {}
    }
    const apps = [...new Set((info?.fabrics || []).map(describe.controllerName))];
    return { commissioningInfo: info, qrDataUrl, apps };
  }

  // ─── Request guard: DNS rebinding + cross-site requests ──────────────────────
  // The UI has no login, so stop other websites (opened in a browser on the LAN)
  // from driving the API. Host must be an IP, localhost, *.local, this machine's
  // hostname, or listed in ui.allowedHosts; mutating requests must be same-origin.

  const allowedHosts = new Set(['localhost', os.hostname().toLowerCase(),
    ...(config.allowedHosts || []).map(h => String(h).toLowerCase())]);

  function hostAllowed(hostHeader) {
    if (!hostHeader) return false;
    const host = hostHeader.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return allowedHosts.has(host) || host.endsWith('.local') || net.isIP(host) !== 0;
  }

  app.use((req, res, next) => {
    if (!hostAllowed(req.headers.host)) {
      return res.status(403).send('Host not allowed — add it to ui.allowedHosts in config.yaml');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      let sameOrigin = true;
      if (origin) {
        try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
      }
      if (!sameOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
        return res.status(403).json({ error: 'Cross-site request blocked' });
      }
    }
    next();
  });

  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'ui', 'public')));

  // ─── SSE: device state ───────────────────────────────────────────────────────

  const stateClients = new Set();
  const logClients = new Set();

  registry.on('state', ({ deviceId, state }) => {
    const payload = `data: ${JSON.stringify({ type: 'state', deviceId, state })}\n\n`;
    for (const res of stateClients) { try { res.write(payload); } catch {} }
  });

  // Broadcast health (lastSeen) for all devices every 15s
  setInterval(() => {
    const health = {};
    for (const d of registry.getAll()) health[d.id] = d.lastSeen;
    const payload = `data: ${JSON.stringify({ type: 'health', health })}\n\n`;
    for (const res of stateClients) { try { res.write(payload); } catch {} }
  }, 15000);

  logger.on('line', (entry) => {
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const res of logClients) { try { res.write(payload); } catch {} }
  });

  // ─── Access gate: setup wizard → login → app ─────────────────────────────────

  app.use((req, res, next) => {
    const isApi = req.path.startsWith('/api/');
    const sendTo = (to) => isApi ? res.status(401).json({ error: 'Not signed in', redirect: to }) : res.redirect(to);

    if (!configManager.isSetupComplete()) {
      const allowed = req.path === '/setup' || req.path === '/api/setup/complete' || req.path === '/api/system/restart';
      return allowed ? next() : sendTo('/setup');
    }
    if (!auth.hasAccount()) {
      // Upgraded from a version without login — creating the account is the only thing allowed
      const allowed = req.path === '/setup' || req.path === '/api/setup/account';
      return allowed ? next() : sendTo('/setup');
    }
    if (req.path === '/login' || req.path === '/api/auth/login') return next();

    const user = auth.currentUser(req);
    if (user) { res.locals.user = user; return next(); }
    if (isApi) return res.status(401).json({ error: 'Not signed in' });
    res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  });

  // ─── Setup wizard ────────────────────────────────────────────────────────────

  app.get('/setup', (req, res) => {
    const setupComplete = configManager.isSetupComplete();
    if (setupComplete && auth.hasAccount()) return res.redirect('/dashboard');
    const cfg = configManager.load();
    res.render('setup', { bridge: cfg.bridge || {}, location: cfg.location || {}, accountOnly: setupComplete });
  });

  app.post('/api/setup/complete', (req, res) => {
    // Once setup is done this must never run again — it wipes the device list
    if (configManager.isSetupComplete()) return res.status(403).json({ error: 'Setup already complete' });
    try {
      const { username, password } = req.body || {};
      auth.validateCredentials(username, password);
      configManager.completeSetup(req.body);
      auth.setCredentials(username, password);
      auth.setSessionCookie(req, res);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/setup/account', (req, res) => {
    if (auth.hasAccount()) return res.status(403).json({ error: 'Account already exists' });
    try {
      const { username, password } = req.body || {};
      auth.setCredentials(username, password);
      auth.setSessionCookie(req, res);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── Login / account ─────────────────────────────────────────────────────────

  // Only same-site paths — never //evil.com or /\evil.com
  const safeNext = (n) => (typeof n === 'string' && /^\/(?![/\\])/.test(n)) ? n : '/dashboard';

  app.get('/login', (req, res) => {
    if (auth.currentUser(req)) return res.redirect(safeNext(req.query.next));
    res.render('login', { next: safeNext(req.query.next) });
  });

  app.post('/api/auth/login', (req, res) => {
    const ip = req.socket.remoteAddress;
    if (auth.isLockedOut(ip)) {
      return res.status(429).json({ error: 'Too many failed attempts — try again in 15 minutes' });
    }
    const { username, password } = req.body || {};
    if (!auth.checkLogin(username, password)) {
      auth.recordFailure(ip);
      console.warn(`[Auth] Failed login for "${String(username || '').slice(0, 32)}" from ${ip}`);
      return res.status(401).json({ error: 'Incorrect username or password' });
    }
    auth.clearFailures(ip);
    auth.setSessionCookie(req, res);
    console.log(`[Auth] ${auth.getAccount().username} signed in from ${ip}`);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.put('/api/account', (req, res) => {
    const { currentPassword, username, newPassword } = req.body || {};
    const account = auth.getAccount();
    if (!auth.verifyPassword(currentPassword || '', account.passwordHash)) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    try {
      // Blank new password = keep the current one (username-only change)
      auth.setCredentials(username || account.username, newPassword || currentPassword);
      auth.setSessionCookie(req, res); // other sessions are signed out by the new secret
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── Pages ──────────────────────────────────────────────────────────────────

  app.get('/', (req, res) => res.redirect('/dashboard'));

  app.get('/dashboard', async (req, res) => {
    const devices = registry.getAll().map(d => ({ ...d, kind: describe.deviceKind(d) }));
    const { names, disabled } = deviceDirectory();
    const nextRuns = scheduler ? scheduler.getNextRuns() : {};
    const byId = Object.fromEntries(automationsManager.getAll().map(a => [a.id, a]));
    const [nextId] = Object.keys(nextRuns).sort((a, b) => nextRuns[a] - nextRuns[b]);
    const comingUp = nextId ? {
      when: describe.whenText(nextRuns[nextId]),
      text: describe.triggerText(byId[nextId].trigger).replace(/ every day$/, '') + ', ' +
        describe.actionsText(byId[nextId].actions.filter(a => !disabled.includes(a.device)), id => names[id] || id),
    } : null;
    const { apps, commissioningInfo } = await pairingInfo();
    const mqtt = mqttBroker.connectionStatus(configManager.load().devices);
    const mqttMissing = mqtt.tracking && mqtt.settled ? mqtt.devices.filter(d => !d.connected).map(d => d.name) : [];
    res.render('dashboard', {
      devices, scenes: scenesManager.getAll(), comingUp, pairedApps: apps, mqttMissing,
      commissioned: commissioningInfo?.commissioned ?? false, page: 'home',
    });
  });

  app.get('/devices', (req, res) => {
    const cfg = configManager.load();
    const liveIds = new Set(registry.getAll().map(d => d.id));
    res.render('devices', {
      devices: cfg.devices,
      liveIds: [...liveIds],
      schemas: configManager.getSchemas(),
      enabledPlugins: configManager.getEnabledPluginNames(),
      describe,
      page: 'devices',
    });
  });

  app.get('/plugins', async (req, res) => {
    res.render('plugins', { plugins: configManager.getPlugins(), schemas: configManager.getSchemas(), brokerRunning: await mqttBroker.isRunning(), page: 'settings', tab: 'integrations' });
  });

  app.get('/mqtt', async (req, res) => {
    const cfg = configManager.load();
    const enabledPlugins = configManager.getEnabledPluginNames();
    const localIp = Object.values(os.networkInterfaces())
      .flat().find(i => i.family === 'IPv4' && !i.internal)?.address || 'localhost';
    const tasmotaDevices = cfg.devices.filter(d => d.plugin === 'tasmota' && d.enabled !== false);
    const shellyDevices  = cfg.devices.filter(d => d.plugin === 'shelly'  && d.enabled !== false);
    const { username: mqttUser, password: mqttPass } = mqttBroker.getCredentials();
    res.render('mqtt', {
      mqttUser,
      mqttPass,
      page: 'settings',
      tab: 'integrations',
      brokerAvailable: await mqttBroker.isAvailable(),
      brokerRunning:   await mqttBroker.isRunning(),
      brokerEnabled:   configManager.getMqttBrokerEnabled(),
      localIp,
      tasmotaEnabled: enabledPlugins.includes('tasmota'),
      shellyEnabled:  enabledPlugins.includes('shelly'),
      tasmotaDevices,
      shellyDevices,
    });
  });

  app.get('/scenes', (req, res) => {
    const { names, disabled } = deviceDirectory();
    res.render('scenes', { scenes: scenesManager.getAll(), devices: allDevicesForUI(registry), deviceNames: names, disabledIds: disabled, page: 'scenes' });
  });

  app.get('/automations', (req, res) => {
    const { names, disabled } = deviceDirectory();
    const nextRuns = scheduler ? scheduler.getNextRuns() : {};
    res.render('automations', {
      automations: automationsManager.getAll(), devices: allDevicesForUI(registry),
      deviceNames: names, disabledIds: disabled, nextRuns, page: 'automations',
    });
  });

  app.get('/logs', (req, res) => {
    res.render('logs', { page: 'settings', tab: 'logs' });
  });

  app.get('/settings', async (req, res) => {
    const cfg = configManager.load();
    res.render('settings', { bridge: cfg.bridge || {}, location: cfg.location || {}, ...(await pairingInfo()), page: 'settings', tab: 'general' });
  });

  app.get('/system', (req, res) => {
    const cfg = configManager.load();
    res.render('system', { bridge: cfg.bridge, page: 'settings', tab: 'system', updateInfo: pushManager.getUpdateInfo() });
  });

  // ─── API: devices ────────────────────────────────────────────────────────────

  app.get('/api/devices', (req, res) => res.json(registry.getAll()));

  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    for (const d of registry.getAll()) {
      res.write(`data: ${JSON.stringify({ type: 'state', deviceId: d.id, state: d.state })}\n\n`);
    }
    stateClients.add(res);
    req.on('close', () => stateClients.delete(res));
  });

  app.post('/api/devices/:id/set', async (req, res) => {
    const { capability, value } = req.body;
    try {
      await registry.set(req.params.id, capability, value);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── API: config ─────────────────────────────────────────────────────────────

  app.post('/api/devices', (req, res) => {
    try {
      const device = configManager.addDevice(req.body);
      res.json({ ok: true, device, message: 'Device added. Restart Rowan Hub to activate.' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/devices/:id', (req, res) => {
    try {
      const device = configManager.updateDevice(req.params.id, req.body);
      res.json({ ok: true, device, message: 'Device updated. Restart Rowan Hub to apply.' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/devices/:id', (req, res) => {
    try {
      configManager.removeDevice(req.params.id);
      res.json({ ok: true, message: 'Device removed. Restart Rowan Hub to apply.' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/devices/:id/toggle', async (req, res) => {
    const enabled = Boolean(req.body.enabled);

    try {
      configManager.toggleDevice(req.params.id, enabled);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    if (!enabled) {
      try { await bridge.removeDevice(req.params.id); } catch (e) {
        return res.status(500).json({ error: `Failed to remove device: ${e.message}` });
      }
      registry.unregister(req.params.id);
      return res.json({ ok: true, message: 'Device disabled and removed from Matter.' });
    }

    // Enable: initialise the plugin driver and add to bridge + registry live
    const cfg = configManager.load();
    const deviceConfig = cfg.devices.find(d => d.id === req.params.id);
    if (!deviceConfig) return res.status(404).json({ error: 'Device not found in config' });

    let plugin;
    try { plugin = require(configManager.pluginPath(deviceConfig.plugin)); } catch {
      return res.status(400).json({ error: `Plugin not found: ${deviceConfig.plugin}` });
    }

    const globalConfig = cfg[deviceConfig.plugin] || {};
    try {
      const driver = await plugin.init(deviceConfig, globalConfig);
      registry.register(deviceConfig.id, deviceConfig, driver);
      await bridge.addDevice(deviceConfig, driver);
      return res.json({ ok: true, message: 'Device enabled and added to Matter.' });
    } catch (e) {
      return res.status(500).json({ error: `Failed to initialise device: ${e.message}` });
    }
  });

  app.put('/api/plugins/:name', (req, res) => {
    try {
      configManager.updatePluginGlobal(req.params.name, req.body);
      res.json({ ok: true, message: 'Plugin settings saved. Restart Rowan Hub to apply.' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/plugins/:name/toggle', (req, res) => {
    try {
      configManager.togglePlugin(req.params.name, Boolean(req.body.enabled));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── API: MQTT broker ────────────────────────────────────────────────────────

  app.get('/api/mqtt/status', async (req, res) => {
    res.json({
      available: await mqttBroker.isAvailable(),
      running:   await mqttBroker.isRunning(),
      enabled:   configManager.getMqttBrokerEnabled(),
    });
  });

  // Which Tasmota / Shelly devices are reaching the (password-protected) broker
  app.get('/api/mqtt/devices', (req, res) => {
    res.json(mqttBroker.connectionStatus(configManager.load().devices));
  });

  app.post('/api/mqtt/probe', (req, res) => {
    mqttBroker.probe(configManager.load().devices);
    res.json({ ok: true });
  });

  app.put('/api/mqtt/broker', async (req, res) => {
    const enable = Boolean(req.body.enabled);
    try {
      if (enable) await mqttBroker.start();
      else        await mqttBroker.stop();
      configManager.setMqttBrokerEnabled(enable);
      res.json({ ok: true, running: enable, restartRequired: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── API: scenes ─────────────────────────────────────────────────────────────

  app.get('/api/scenes', (req, res) => res.json(scenesManager.getAll()));

  app.post('/api/scenes', (req, res) => {
    try { res.json(scenesManager.create(req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.put('/api/scenes/:id', (req, res) => {
    try { res.json(scenesManager.update(req.params.id, req.body)); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.delete('/api/scenes/:id', (req, res) => {
    try { scenesManager.delete(req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.post('/api/scenes/:id/trigger', async (req, res) => {
    const scene = scenesManager.getAll().find(s => s.id === req.params.id);
    if (!scene) return res.status(404).json({ error: 'Scene not found' });
    try {
      for (const action of scene.actions) {
        await registry.set(action.device, action.capability, action.value);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── API: automations ────────────────────────────────────────────────────────

  app.get('/api/automations', (req, res) => res.json(automationsManager.getAll()));

  app.post('/api/automations', (req, res) => {
    try {
      const auto = automationsManager.create(req.body);
      if (scheduler) scheduler.reload();
      res.json(auto);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/automations/:id', (req, res) => {
    try {
      const auto = automationsManager.update(req.params.id, req.body);
      if (scheduler) scheduler.reload();
      res.json(auto);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/automations/:id/toggle', (req, res) => {
    try {
      const auto = automationsManager.toggle(req.params.id, Boolean(req.body.enabled));
      if (scheduler) scheduler.reload();
      res.json(auto);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/automations/:id', (req, res) => {
    try {
      automationsManager.delete(req.params.id);
      if (scheduler) scheduler.reload();
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── API: location ───────────────────────────────────────────────────────────

  app.put('/api/location', (req, res) => {
    try {
      const { latitude, longitude } = req.body;
      if (latitude === undefined || longitude === undefined) throw new Error('latitude and longitude required');
      configManager.updateLocation(latitude, longitude);
      if (scheduler) {
        scheduler.setLocation(configManager.load().location);
        scheduler.reload();
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── API: logs ───────────────────────────────────────────────────────────────

  app.get('/api/logs/history', (req, res) => res.json(logger.getRecent()));

  app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    for (const entry of logger.getRecent()) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    logClients.add(res);
    req.on('close', () => logClients.delete(res));
  });

  // ─── API: system ─────────────────────────────────────────────────────────────

  app.get('/api/system', (req, res) => {
    const mem = process.memoryUsage();
    const cpuLoad = os.loadavg()[0];
    const commissioningInfo = bridge ? bridge.getCommissioningInfo() : null;
    res.json({
      uptime: Math.floor((Date.now() - startTime) / 1000),
      nodeVersion: process.version,
      platform: os.platform(),
      hostname: os.hostname(),
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      processMem: mem.rss,
      cpuLoad: cpuLoad.toFixed(2),
      deviceCount: registry.getAll().length,
      version: require('../package.json').version,
      windowStatus: commissioningInfo?.windowStatus ?? 0,
      updateInfo: pushManager.getUpdateInfo(),
    });
  });

  app.post('/api/system/open-commissioning', async (req, res) => {
    if (!bridge) return res.status(503).json({ error: 'Bridge not available' });
    try {
      await bridge.openCommissioningWindow(900);
      res.json({ ok: true, timeout: 900 });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ─── API: push notifications ─────────────────────────────────────────────────

  app.get('/api/push/vapid-public-key', (req, res) => {
    res.json({ publicKey: pushManager.getPublicKey() });
  });

  app.post('/api/push/subscribe', (req, res) => {
    try {
      pushManager.addSubscription(req.body);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/push/subscribe', (req, res) => {
    pushManager.removeSubscription(req.body.endpoint);
    res.json({ ok: true });
  });

  app.post('/api/system/restart', (req, res) => {
    res.json({ ok: true, message: 'Restarting…' });
    setTimeout(() => process.exit(0), 500);
  });

  // Updates only move to the latest published GitHub release tag (never whatever is on
  // main), fast-forward only, with dependency install scripts disabled. Rolls back on failure.
  let updating = false;
  app.post('/api/system/update', async (req, res) => {
    const info = pushManager.getUpdateInfo();
    if (!info.updateAvailable) return res.status(400).json({ error: 'No newer release available' });
    if (updating) return res.status(409).json({ error: 'Update already in progress' });
    updating = true;

    const { execFile } = require('child_process');
    const cwd = path.join(__dirname, '..');
    const env = { ...process.env, HOME: os.userInfo().homedir, npm_config_cache: path.join(cwd, '.npm-cache') };
    const run = (cmd, args) => new Promise((resolve, reject) => {
      execFile(cmd, args, { cwd, env, timeout: 300000 }, (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-3).join(' ')));
        else resolve(stdout.trim());
      });
    });

    const tag = `v${info.latestVersion}`;
    let prev;
    try {
      prev = await run('git', ['rev-parse', 'HEAD']);
      await run('git', ['fetch', '--quiet', 'origin', `+refs/tags/${tag}:refs/tags/${tag}`]);
      await run('git', ['merge', '--ff-only', '--quiet', `${tag}^{commit}`]);
    } catch (e) {
      updating = false;
      return res.status(400).json({ error: `Update failed: ${e.message}` });
    }

    try {
      await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
    } catch (e) {
      console.error(`[Update] npm ci failed (${e.message}) — rolling back to ${prev.slice(0, 7)}`);
      try {
        await run('git', ['reset', '--hard', '--quiet', prev]);
        await run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
      } catch (e2) {
        console.error(`[Update] Rollback dependency install failed: ${e2.message}`);
      }
      updating = false;
      return res.status(500).json({ error: `Update failed while installing dependencies — rolled back. ${e.message}` });
    }

    console.log(`[Update] Updated to ${tag} — restarting`);
    res.json({ ok: true, message: `Updated to ${tag}. Restarting…` });
    setTimeout(() => process.exit(0), 500);
  });

  app.listen(port, () => {
    console.log(`[Rowan Hub] Web UI → http://localhost:${port}`);
  });

  // HTTPS — required for push notifications and service workers on phones
  const httpsPort = config.httpsPort || 3443;
  let certConfig;
  if (config.certFile && config.keyFile) {
    try {
      certConfig = { cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) };
      console.log('[Rowan Hub] HTTPS using configured certificate');
    } catch (e) {
      console.warn(`[Rowan Hub] Could not load TLS cert: ${e.message} — HTTPS disabled`);
    }
  } else {
    certConfig = await loadOrGenerateCert();
  }

  if (certConfig) {
    https.createServer(certConfig, app).listen(httpsPort, () => {
      console.log(`[Rowan Hub] Web UI (HTTPS) → https://localhost:${httpsPort}`);
    });
  }
}

module.exports = { startUiServer };
