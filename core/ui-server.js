const express = require('express');
const https = require('https');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');
const logger = require('./logger');
const configManager = require('./config-manager');
const automationsManager = require('./automations-manager');
const scenesManager = require('./scenes-manager');
const pushManager = require('./push-manager');

const CERT_PATH = path.join(__dirname, '..', 'hazel-cert.pem');
const KEY_PATH  = path.join(__dirname, '..', 'hazel-key.pem');

async function loadOrGenerateCert() {
  if (fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    return { cert: fs.readFileSync(CERT_PATH), key: fs.readFileSync(KEY_PATH) };
  }
  console.log('[Hazel] Generating self-signed TLS certificate…');
  const attrs = [{ name: 'commonName', value: 'hazel.local' }];
  const opts  = { days: 3650, keySize: 2048 };
  const pems  = await selfsigned.generate(attrs, opts);
  fs.writeFileSync(CERT_PATH, pems.cert);
  fs.writeFileSync(KEY_PATH,  pems.private);
  return { cert: pems.cert, key: pems.private };
}

const startTime = Date.now();

async function startUiServer(registry, config, scheduler, bridge) {
  const app = express();
  const port = config.port || 3088;

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'ui', 'views'));
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

  // ─── Pages ──────────────────────────────────────────────────────────────────

  app.get('/', (req, res) => res.redirect('/dashboard'));

  app.get('/dashboard', (req, res) => {
    res.render('dashboard', { devices: registry.getAll(), scenes: scenesManager.getAll(), page: 'dashboard' });
  });

  app.get('/devices', (req, res) => {
    const cfg = configManager.load();
    const liveIds = new Set(registry.getAll().map(d => d.id));
    res.render('devices', {
      devices: cfg.devices,
      liveIds: [...liveIds],
      schemas: configManager.getSchemas(),
      enabledPlugins: configManager.getEnabledPluginNames(),
      page: 'devices',
    });
  });

  app.get('/plugins', (req, res) => {
    res.render('plugins', { plugins: configManager.getPlugins(), schemas: configManager.getSchemas(), page: 'plugins' });
  });

  app.get('/scenes', (req, res) => {
    const devices = registry.getAll().map(d => ({ id: d.id, name: d.name, capabilities: d.capabilities, presets: d.presets || [] }));
    res.render('scenes', { scenes: scenesManager.getAll(), devices, page: 'scenes' });
  });

  app.get('/automations', (req, res) => {
    const devices = registry.getAll().map(d => ({ id: d.id, name: d.name, capabilities: d.capabilities, presets: d.presets || [] }));
    res.render('automations', { automations: automationsManager.getAll(), devices, page: 'automations' });
  });

  app.get('/logs', (req, res) => {
    res.render('logs', { page: 'logs' });
  });

  app.get('/system', async (req, res) => {
    const cfg = configManager.load();
    const commissioningInfo = bridge ? bridge.getCommissioningInfo() : null;
    let qrDataUrl = null;
    if (commissioningInfo?.qrPairingCode) {
      try {
        qrDataUrl = await QRCode.toDataURL(commissioningInfo.qrPairingCode, { width: 220, margin: 2, color: { dark: '#000', light: '#fff' } });
      } catch {}
    }
    res.render('system', { bridge: cfg.bridge, location: cfg.location || {}, page: 'system', commissioningInfo, qrDataUrl });
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

  app.get('/api/config', (req, res) => res.json(configManager.load()));

  app.post('/api/devices', (req, res) => {
    try {
      const device = configManager.addDevice(req.body);
      res.json({ ok: true, device, message: 'Device added. Restart Hazel to activate.' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/devices/:id', (req, res) => {
    try {
      const device = configManager.updateDevice(req.params.id, req.body);
      res.json({ ok: true, device, message: 'Device updated. Restart Hazel to apply.' });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/devices/:id', (req, res) => {
    try {
      configManager.removeDevice(req.params.id);
      res.json({ ok: true, message: 'Device removed. Restart Hazel to apply.' });
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
      await bridge.removeDevice(req.params.id);
      registry.unregister(req.params.id);
      return res.json({ ok: true, message: 'Device disabled and removed from Matter.' });
    }

    // Enable: initialise the plugin driver and add to bridge + registry live
    const cfg = configManager.load();
    const deviceConfig = cfg.devices.find(d => d.id === req.params.id);
    if (!deviceConfig) return res.status(404).json({ error: 'Device not found in config' });

    const pluginPath = path.join(__dirname, '..', 'plugins', deviceConfig.plugin, 'index');
    let plugin;
    try { plugin = require(pluginPath); } catch {
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
      res.json({ ok: true, message: 'Plugin settings saved. Restart Hazel to apply.' });
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
      if (scheduler) scheduler.reload();
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

  app.listen(port, () => {
    console.log(`[Hazel] Web UI → http://localhost:${port}`);
  });

  // HTTPS — required for push notifications and service workers on phones
  const httpsPort = config.httpsPort || 3443;
  let certConfig;
  if (config.certFile && config.keyFile) {
    try {
      certConfig = { cert: fs.readFileSync(config.certFile), key: fs.readFileSync(config.keyFile) };
      console.log('[Hazel] HTTPS using configured certificate');
    } catch (e) {
      console.warn(`[Hazel] Could not load TLS cert: ${e.message} — HTTPS disabled`);
    }
  } else {
    certConfig = await loadOrGenerateCert();
  }

  if (certConfig) {
    https.createServer(certConfig, app).listen(httpsPort, () => {
      console.log(`[Hazel] Web UI (HTTPS) → https://localhost:${httpsPort}`);
    });
  }
}

module.exports = { startUiServer };
