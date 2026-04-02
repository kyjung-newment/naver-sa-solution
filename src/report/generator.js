const { createApiClient } = require('../api/naverApi');
const { sendReport } = require('../email/sender');

function getPeriodLabel(type) {
  const today = new Date();
  const fmt = d => d.toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (type === 'daily') {
    const d = new Date(today); d.setDate(d.getDate() - 1);
    return `${fmt(d)} (어제)`;
  }
  if (type === 'weekly') {
    const end = new Date(today); end.setDate(end.getDate() - 1);
    const start = new Date(today); start.setDate(start.getDate() - 7);
    return `${fmt(start)} ~ ${fmt(end)} (최근 7일)`;
  }
  if (type === 'monthly') {
    const end = new Date(today); end.setDate(end.getDate() - 1);
    const start = new Date(today); start.setDate(start.getDate() - 30);
    return `${fmt(start)} ~ ${fmt(end)} (최근 30일)`;
  }
  return '';
}

const TIME_RANGE_MAP = { daily: 'yesterday', weekly: 'last7days', monthly: 'last30days' };

/**
 * @param {object} account - DB의 ad_accounts + users JOIN 결과 (api_key, secret_key 포함)
 * @param {'daily'|'weekly'|'monthly'} type
 */
async function generateAndSend(account, type) {
  console.log(`\n📊 [${account.name}] ${type.toUpperCase()} 리포트 생성...`);

  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  try {
    const timeRange = TIME_RANGE_MAP[type];

    const [stats, keywordStats] = await Promise.all([
      client.getStats({ timeRange }).catch(err => { console.error('통계 조회 실패:', err.message); return null; }),
      client.getKeywordStats({ timeRange }).catch(err => { console.error('키워드 통계 실패:', err.message); return []; }),
    ]);

    let prevStats = null;
    if (type === 'daily') {
      const d = new Date(); d.setDate(d.getDate() - 2);
      const s = d.toISOString().slice(0, 10);
      prevStats = await client.getStats({ timeRange: 'custom', startDate: s, endDate: s }).catch(() => null);
    }

    await sendReport({
      account,
      type,
      period: getPeriodLabel(type),
      stats: stats || {},
      keywordStats: Array.isArray(keywordStats) ? keywordStats : [],
      prevStats,
    });

    console.log(`✅ [${account.name}] ${type.toUpperCase()} 완료`);
    return true;
  } catch (err) {
    console.error(`❌ [${account.name}] ${type.toUpperCase()} 오류:`, err.message);
    return false;
  }
}

module.exports = { generateAndSend };
