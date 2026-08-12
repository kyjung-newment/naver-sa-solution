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

// 루트 → 대시보드로 리디렉션
app.get('/', (req, res) => res.redirect('/smart-sa'));

// 대시보드
app.use('/smart-sa', dashboardRouter);

// 입찰 자동 조정 웹앱 (같은 코드·데이터, URL 2종)
// - /egojin-bid : 이고진(242566) 전용 (기존 링크 유지)
// - /auto-bid   : 범용 멀티 브랜드 — 광고주 선택·추가 가능
app.use('/egojin-bid', createBidApp({
  base: '/egojin-bid',
  appName: '이고진 입찰관리',
  appSubtitle: 'Naver SA Shopping Bid Manager',
  pinnedCustomerId: '242566',
  pinnedLabel: '이고진',
}));
app.use('/auto-bid', createBidApp({
  base: '/auto-bid',
  appName: 'NEWMENT 오토비드',
  appSubtitle: 'Naver SA Auto Bidding · Multi-Brand',
}));

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
