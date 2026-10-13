module.exports = {
  apps: [
    {
      name: 'wa-baileys',
      script: './index.js',
      cwd: '/var/www/wa.rusabyte.co.id',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '350M',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 3012,
      },
    },
  ],
};
