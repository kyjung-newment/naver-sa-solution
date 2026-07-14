require('dotenv').config();

const config = {
  server: {
    port: parseInt(process.env.PORT) || 3000,
    domain: process.env.SITE_DOMAIN || 'http://localhost:3000',
  },

  sessionSecret: process.env.SESSION_SECRET || 'naver-sa-secret-change-me',

  cron: {
    daily:   process.env.CRON_DAILY   || '0 9 * * *',
    weekly:  process.env.CRON_WEEKLY  || '0 9 * * 1',
    monthly: process.env.CRON_MONTHLY || '0 9 1 * *',
  },

  // 기능 플래그 (대시보드/스케줄러 공용 — 단일 소스)
  // DA(GFA): 쿠키 세션 기반이라 자동 토큰 갱신 불가 → 공식 API 연동 전까지 비활성화
  // 자동입찰: '원클릭 계정분석 제안'으로 대체. 데이터는 보존되므로 true로 바꾸면 복구됨
  features: {
    DA: false,           // DA 성과 대시보드 + DA 리포트
    AUTOBID: false,      // 파워링크 자동입찰
    SHOPPING_BID: false, // 쇼핑검색 자동입찰
  },
};

module.exports = { config };
