module.exports = {
  apps: [
    {
      name: 'wa-baileys-ppra',
      script: './index.js',
      cwd: '/Users/iqbaldev/Sites/wa-baileys',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '350M',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
      },
    },
  ],
};
