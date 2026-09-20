const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'automations.json');

class AutomationsManager {
  getAll() {
    try {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      return [];
    }
  }

  save(automations) {
    fs.writeFileSync(FILE, JSON.stringify(automations, null, 2));
  }

  create(data) {
    const automations = this.getAll();
    const auto = { ...data, id: crypto.randomUUID(), enabled: true };
    automations.push(auto);
    this.save(automations);
    return auto;
  }

  update(id, data) {
    const automations = this.getAll();
    const i = automations.findIndex(a => a.id === id);
    if (i === -1) throw new Error('Automation not found');
    automations[i] = { ...automations[i], ...data, id };
    this.save(automations);
    return automations[i];
  }

  toggle(id, enabled) {
    return this.update(id, { enabled });
  }

  delete(id) {
    const automations = this.getAll().filter(a => a.id !== id);
    this.save(automations);
  }
}

module.exports = new AutomationsManager();
