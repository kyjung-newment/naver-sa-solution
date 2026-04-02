const cron = require('node-cron');
const { config } = require('../../config');
const { generateAndSend } = require('../report/generator');
const { runAutoBiddingForAccount } = require('./autoBid');
const db = require('../db/database');

function startScheduler() {
  console.log('\n⏰ 스케줄러 시작\n');

  // ── 일간 리포트 (매일 08:00 KST) ─────────────────────────────
  cron.schedule(config.cron.daily, async () => {
    console.log('\n📅 일간 리포트 스케줄 실행');
    const accounts = await db.getAllAccountsWithFeature('daily_report');
    for (const account of accounts) await generateAndSend(account, 'daily');
  }, { timezone: 'Asia/Seoul' });
  console.log(`  ✅ 일간 리포트: ${config.cron.daily}`);

  // ── 주간 리포트 (월요일 09:00 KST) ───────────────────────────
  cron.schedule(config.cron.weekly, async () => {
    console.log('\n📅 주간 리포트 스케줄 실행');
    const accounts = await db.getAllAccountsWithFeature('weekly_report');
    for (const account of accounts) await generateAndSend(account, 'weekly');
  }, { timezone: 'Asia/Seoul' });
  console.log(`  ✅ 주간 리포트: ${config.cron.weekly}`);

  // ── 월간 리포트 (매월 1일 09:00 KST) ────────────────────────
  cron.schedule(config.cron.monthly, async () => {
    console.log('\n📅 월간 리포트 스케줄 실행');
    const accounts = await db.getAllAccountsWithFeature('monthly_report');
    for (const account of accounts) await generateAndSend(account, 'monthly');
  }, { timezone: 'Asia/Seoul' });
  console.log(`  ✅ 월간 리포트: ${config.cron.monthly}`);

  // ── 자동입찰 (각 광고주별 설정 간격) ────────────────────────
  // 1분마다 자동입찰 ON 계정 조회 후 각 계정의 interval 확인
  cron.schedule('* * * * *', async () => {
    const accounts = await db.getAllAccountsWithFeature('auto_bidding');
    const now = Date.now();
    for (const account of accounts) {
      const intervalMs = (account.auto_bid_interval || 5) * 60 * 1000;
      const lastRun = autoBidLastRun.get(account.id) || 0;
      if (now - lastRun >= intervalMs) {
        autoBidLastRun.set(account.id, now);
        runAutoBiddingForAccount(account).catch(console.error);
      }
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('  ✅ 자동입찰: 활성 광고주별 개별 간격\n');
}

const autoBidLastRun = new Map();

module.exports = { startScheduler };
