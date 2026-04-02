require('dotenv').config();

const config = {
  server: {
    port: parseInt(process.env.PORT) || 3000,
    domain: process.env.SITE_DOMAIN || 'http://localhost:3000',
  },

  sessionSecret: process.env.SESSION_SECRET || 'naver-sa-secret-change-me',

  cron: {
    daily:   process.env.CRON_DAILY   || '0 8 * * *',
    weekly:  process.env.CRON_WEEKLY  || '0 9 * * 1',
    monthly: process.env.CRON_MONTHLY || '0 9 1 * *',
  },
};

module.exports = { config };
