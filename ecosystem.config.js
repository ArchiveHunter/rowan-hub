const { execSync } = require('child_process');

// Run as the unprivileged `rowanhub` service user when it exists (created by install.sh)
let user = {};
try {
  execSync('id -u rowanhub', { stdio: 'ignore' });
  user = { uid: 'rowanhub', gid: 'rowanhub' };
} catch {}

module.exports = {
  apps: [{
    name: 'rowan-hub',
    script: 'rowan-hub.js',
    cwd: __dirname,
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    ...user,
    env: { NODE_ENV: 'production' }
  }]
};
