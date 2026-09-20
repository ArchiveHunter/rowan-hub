module.exports = {
  apps: [{
    name: 'hazel',
    script: 'hazel.js',
    cwd: '/root/hazel',
    exec_mode: 'fork',
    autorestart: true,
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
};
