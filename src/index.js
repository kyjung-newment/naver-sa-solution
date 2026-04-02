require('dotenv').config();
const express = require('express');
const path = require('path');
const { config } = require('../config');
const { router: dashboardRouter } = require('./dashboard/server');
const { initDb } = require('./db/database');

const IS_VERCEL = !!process.env.VERCEL;

const app = express();

// 정적 파일
app.use('/public', express.static(path.join(__dirname, '../public')));

// 루트 → 대시보드로 리디렉션
app.get('/', (req, res) => res.redirect('/smart-sa'));

// 대시보드
app.use('/smart-sa', dashboardRouter);

// 헬스체크
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime(), env: IS_VERCEL ? 'vercel' : 'local' }));

// ─── Vercel: app을 서버리스 함수로 내보내기 ────────────────────────
// (initDb는 첫 요청 전에 완료됨)
const ready = initDb().catch(err => {
  console.error('❌ DB 초기화 실패:', err.message);
  process.exit(1);
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
