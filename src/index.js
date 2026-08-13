require('dotenv').config();
const express = require('express');
const path = require('path');
const { config } = require('../config');
const { router: dashboardRouter } = require('./dashboard/server');
const { createBidApp } = require('./bidapp/server');
const { initDb } = require('./db/database');
const { initBidDb } = require('./bidapp/db');

const IS_VERCEL = !!process.env.VERCEL;

const app = express();

// 정적 파일
app.use('/public', express.static(path.join(__dirname, '../public')));

// 루트 → 접속 도메인에 따라 솔루션 분기
// - *auto-bid*.vercel.app (예: tf-auto-bid.vercel.app) → AUTO BID
// - *auto-report*.vercel.app (예: tf-auto-report.vercel.app) 및 그 외 → AUTO REPORT(/smart-sa)
app.get('/', (req, res) => {
  const host = String(req.hostname || req.headers.host || '').toLowerCase();
  if (host.includes('auto-bid')) return res.redirect('/auto-bid');
  return res.redirect('/smart-sa');
});

// 대시보드
app.use('/smart-sa', dashboardRouter);

// 입찰 자동 조정 웹앱 — 채널 2종(SPO=쇼핑검색 소재 / PPO=파워링크 키워드) × URL 2종
// - /egojin-bid/spo·/ppo : 이고진(242566) 전용 (레거시 /egojin-bid = SPO 재마운트, 크론 tick 포함)
// - /auto-bid/spo·/ppo   : 범용 멀티 브랜드 (레거시 /auto-bid = SPO 재마운트)
const egojinCfg = { appName: '이고진 입찰관리', pinnedCustomerId: '242566', pinnedLabel: '이고진' };
const egojinSpo = createBidApp({ ...egojinCfg, base: '/egojin-bid/spo', channel: 'shopping', appSubtitle: '쇼핑검색 성과최적화 (SPO)' });
const egojinPpo = createBidApp({ ...egojinCfg, base: '/egojin-bid/ppo', channel: 'powerlink', appSubtitle: '파워링크 성과최적화 (PPO)' });
app.use('/egojin-bid/spo', egojinSpo);
app.use('/egojin-bid/ppo', egojinPpo);
app.use('/egojin-bid', egojinSpo); // 레거시 경로 — 링크는 /spo 기준으로 렌더링됨

const autoSpo = createBidApp({ base: '/auto-bid/spo', channel: 'shopping', appName: 'AUTO BID', appSubtitle: '쇼핑검색 성과최적화 (SPO)' });
const autoPpo = createBidApp({ base: '/auto-bid/ppo', channel: 'powerlink', appName: 'AUTO BID', appSubtitle: '파워링크 성과최적화 (PPO)' });
app.use('/auto-bid/spo', autoSpo);
app.use('/auto-bid/ppo', autoPpo);
app.use('/auto-bid', autoSpo); // 레거시 경로

// 헬스체크
app.get('/health', async (req, res) => {
  let dbRead = 'unknown', dbWrite = 'unknown';
  try {
    const { pool } = require('./db/database');
    const r = await pool.query('SELECT COUNT(*)::int AS cnt FROM users');
    dbRead = 'ok (users:' + r.rows[0].cnt + ')';
    // 쓰기 테스트
    await pool.query("CREATE TEMP TABLE _health_test (x int); DROP TABLE IF EXISTS _health_test;");
    dbWrite = 'ok';
  } catch (e) {
    if (dbRead === 'unknown') dbRead = 'error: ' + e.message;
    else dbWrite = 'FAIL: ' + e.message;
  }
  res.json({ status: 'ok', uptime: process.uptime(), env: IS_VERCEL ? 'vercel' : 'local', dbRead, dbWrite });
});

// ─── Vercel: app을 서버리스 함수로 내보내기 ────────────────────────
// (initDb는 첫 요청 전에 완료됨)
const ready = initDb()
  .then(() => initBidDb())
  .catch(err => {
    console.warn('⚠️ DB 스키마 초기화 실패 (기존 테이블로 계속 진행):', err.message);
  });

module.exports = async (req, res) => {
  await ready;
  app(req, res);
};

// ─── 로컬 실행 ──────────────────────────────────────────────────────
if (!IS_VERCEL) {
  const { startScheduler } = require('./scheduler');

  ready.then(() => {
    console.log('');
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║   네이버 SA 솔루션 v2.0                     ║');
    console.log('║   광고대행사 멀티계정 관리 시스템           ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log('');

    app.listen(config.server.port, () => {
      console.log(`🚀 서버 실행: http://localhost:${config.server.port}`);
      console.log(`🔗 대시보드:  http://localhost:${config.server.port}/smart-sa`);
      console.log('');
    });

    startScheduler();
  });

  process.on('unhandledRejection', err => console.error('Unhandled:', err.message));
  process.on('uncaughtException',  err => console.error('Uncaught:',  err.message));
}
