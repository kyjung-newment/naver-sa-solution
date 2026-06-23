const cron = require('node-cron');
const { config } = require('../../config');
const { generateAndSend } = require('../report/generator');
const { runAutoBiddingForAccount } = require('./autoBid');
const { runShoppingAutoBidForAccount } = require('./shoppingAutoBid');
const { createApiClient } = require('../api/naverApi');
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

  // ── 네이버 리포트 job 정리 (매일 06:30 KST, 계정당 100 한도 누적 방지) ──
  cron.schedule('30 6 * * *', async () => {
    console.log('\n🧹 리포트 job 정리 스케줄 실행');
    const seen = new Set(); const accts = [];
    for (const feat of ['daily_report', 'weekly_report', 'monthly_report']) {
      try { for (const a of await db.getAllAccountsWithFeature(feat)) { if (a.api_key && a.secret_key && !seen.has(a.id)) { seen.add(a.id); accts.push(a); } } } catch (_) {}
    }
    let total = 0;
    for (const a of accts) {
      try {
        const client = createApiClient({ apiKey: a.api_key, secretKey: a.secret_key, customerId: a.customer_id });
        total += await client.cleanupReportJobs();
      } catch (_) {}
    }
    console.log(`  ✅ 리포트 job 정리: ${accts.length}개 계정, ${total}개 삭제`);
  }, { timezone: 'Asia/Seoul' });
  console.log('  ✅ 리포트 job 정리: 매일 06:30');

  // ── 파워링크 자동입찰 (각 광고주별 설정 간격) ────────────────
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
  console.log('  ✅ 파워링크 자동입찰: 활성 광고주별 개별 간격');

  // ── 쇼핑검색 자동입찰 (5분마다) ──────────────────────────────
  cron.schedule('*/5 * * * *', async () => {
    const accounts = await db.getAllAccountsWithFeature('shopping_auto_bidding');
    for (const account of accounts) {
      runShoppingAutoBidForAccount(account).catch(console.error);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('  ✅ 쇼핑검색 자동입찰: 5분 간격\n');
}

const autoBidLastRun = new Map();

module.exports = { startScheduler };
