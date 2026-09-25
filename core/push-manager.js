const webpush = require('web-push');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const KEYS_PATH = path.join(__dirname, '..', 'push-vapid.json');
const SUBS_PATH = path.join(__dirname, '..', 'push-subscriptions.json');
const { version } = require('../package.json');

class PushManager {
  constructor() {
    this._keys = this._loadKeys();
    this._subscriptions = this._loadSubs();
    webpush.setVapidDetails('mailto:hello@rowanhub.co.uk', this._keys.publicKey, this._keys.privateKey);
  }

  _loadKeys() {
    if (fs.existsSync(KEYS_PATH)) {
      return JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
    }
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(KEYS_PATH, JSON.stringify(keys, null, 2));
    return keys;
  }

  _loadSubs() {
    if (!fs.existsSync(SUBS_PATH)) return [];
    try { return JSON.parse(fs.readFileSync(SUBS_PATH, 'utf8')); } catch { return []; }
  }

  _saveSubs() {
    fs.writeFileSync(SUBS_PATH, JSON.stringify(this._subscriptions, null, 2));
  }

  getPublicKey() {
    return this._keys.publicKey;
  }

  addSubscription(sub) {
    if (!this._subscriptions.find(s => s.endpoint === sub.endpoint)) {
      this._subscriptions.push(sub);
      this._saveSubs();
    }
  }

  removeSubscription(endpoint) {
    this._subscriptions = this._subscriptions.filter(s => s.endpoint !== endpoint);
    this._saveSubs();
  }

  async send(title, body, options = {}) {
    if (!this._subscriptions.length) return;
    const payload = JSON.stringify({ title, body, tag: options.tag || 'rowan-hub', icon: '/rowan-hub.png' });
    const dead = [];
    for (const sub of this._subscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint);
      }
    }
    if (dead.length) {
      this._subscriptions = this._subscriptions.filter(s => !dead.includes(s.endpoint));
      this._saveSubs();
    }
  }

  async checkForUpdate() {
    try {
      const { data } = await axios.get(
        'https://api.github.com/repos/ArchiveHunter/rowan-hub/releases/latest',
        { timeout: 8000, headers: { 'User-Agent': 'rowan-hub' } }
      );
      const latest = data.tag_name?.replace(/^v/, '');
      if (latest && latest !== version) {
        await this.send(
          'Rowan Hub — Update Available',
          `v${latest} is available (you have v${version}).`,
          { tag: 'rowan-hub-update' }
        );
      }
    } catch {} // No releases yet, network error, or rate limit — silently ignore
  }

  startUpdateChecks() {
    this.checkForUpdate();
    setInterval(() => this.checkForUpdate(), 24 * 60 * 60 * 1000);
  }
}

module.exports = new PushManager();
