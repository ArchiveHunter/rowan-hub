module.exports = {
  apps: [{
    name: 'rowan-hub',
    script: 'rowan-hub.js',
    cwd: '/root/hazel-matter',
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
};
