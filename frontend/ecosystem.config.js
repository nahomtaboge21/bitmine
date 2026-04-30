/**
 * PM2 Ecosystem Config
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 reload ecosystem.config.js   ← zero-downtime reload
 */
module.exports = {
  apps: [
    {
      name:             'bitpuzzle-ui',
      script:           'server.js',
      cwd:              __dirname,
      instances:        1,
      autorestart:      true,
      watch:            false,
      restart_delay:    3000,
      max_restarts:     20,
      env: {
        NODE_ENV: 'production',
        PORT:     3000
      },
      log_date_format:  'YYYY-MM-DD HH:mm:ss',
      error_file:       'logs/pm2-error.log',
      out_file:         'logs/pm2-out.log',
      merge_logs:       true
    }
  ]
};
