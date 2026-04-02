#!/usr/bin/env node
require('dotenv').config();
const { initDb, getAllAccountsWithFeature } = require('../db/database');
const { generateAndSend } = require('../report/generator');

const type = process.argv[2];
if (!['daily', 'weekly', 'monthly'].includes(type)) {
  console.error('사용법: node src/scheduler/run.js [daily|weekly|monthly]');
  process.exit(1);
}

(async () => {
  initDb();
  await new Promise(r => setTimeout(r, 500)); // DB 초기화 대기
  const featureMap = { daily: 'daily_report', weekly: 'weekly_report', monthly: 'monthly_report' };
  const accounts = await getAllAccountsWithFeature(featureMap[type]);
  if (!accounts.length) { console.log('활성화된 광고주 없음'); process.exit(0); }
  for (const account of accounts) await generateAndSend(account, type);
  process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
