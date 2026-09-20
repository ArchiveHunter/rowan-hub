const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, '..', 'scenes.json');

class ScenesManager {
  getAll() {
    try {
      return JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      return [];
    }
  }

  save(scenes) {
    fs.writeFileSync(FILE, JSON.stringify(scenes, null, 2));
  }

  create(data) {
    const scenes = this.getAll();
    const scene = { ...data, id: crypto.randomUUID() };
    scenes.push(scene);
    this.save(scenes);
    return scene;
  }

  update(id, data) {
    const scenes = this.getAll();
    const i = scenes.findIndex(s => s.id === id);
    if (i === -1) throw new Error('Scene not found');
    scenes[i] = { ...scenes[i], ...data, id };
    this.save(scenes);
    return scenes[i];
  }

  delete(id) {
    this.save(this.getAll().filter(s => s.id !== id));
  }
}

module.exports = new ScenesManager();
