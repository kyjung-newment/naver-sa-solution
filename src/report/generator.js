const { createApiClient } = require('../api/naverApi');
const { sendReport } = require('../email/sender');

const TIME_RANGE_MAP = { daily: 'yesterday', weekly: 'last7days', monthly: 'last30days' };

function getDateRange(type) {
  // KST 기준 오늘 날짜
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const fmt = d => {
    const k = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return k.toISOString().slice(0, 10);
  };
  const fmtLocal = d => d.toISOString().slice(0, 10);

  if (type === 'daily') {
    // 어제
    const d = new Date(now); d.setDate(d.getDate() - 1);
    return { since: fmt(d), until: fmt(d) };
  }
  if (type === 'weekly') {
    // 지난주 월요일~일요일 (KST 기준)
    const todayKST = new Date(kstNow.toISOString().slice(0, 10));
    const dayOfWeek = todayKST.getDay(); // 0=일, 1=월, ...
    // 지난주 일요일 = 오늘 - dayOfWeek (이번주 일) - 7 + 7 = 오늘 기준 지난 일요일
    const lastSunday = new Date(todayKST);
    lastSunday.setDate(todayKST.getDate() - (dayOfWeek === 0 ? 7 : dayOfWeek));
    const lastMonday = new Date(lastSunday);
    lastMonday.setDate(lastSunday.getDate() - 6);
    return { since: fmtLocal(lastMonday), until: fmtLocal(lastSunday) };
  }
  if (type === 'monthly') {
    // 지난달 1일 ~ 말일
    const kstYear = kstNow.getUTCFullYear();
    const kstMonth = kstNow.getUTCMonth(); // 0-indexed, 현재 달
    const lastMonthStart = new Date(Date.UTC(kstYear, kstMonth - 1, 1));
    const lastMonthEnd = new Date(Date.UTC(kstYear, kstMonth, 0)); // 지난달 마지막일
    return { since: fmtLocal(lastMonthStart), until: fmtLocal(lastMonthEnd) };
  }
  const d = new Date(now); d.setDate(d.getDate() - 1);
  return { since: fmt(d), until: fmt(d) };
}

function getPeriodLabel(type, dateRange) {
  const fmtKo = s => {
    const [y, m, d] = s.split('-');
    return `${y}.${m}.${d}`;
  };
  const label = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || '';
  if (dateRange.since === dateRange.until) {
    return `${fmtKo(dateRange.since)} (${label})`;
  }
  return `${fmtKo(dateRange.since)} ~ ${fmtKo(dateRange.until)} (${label})`;
}

function getDatesBetween(since, until) {
  const dates = [];
  const start = new Date(since);
  const end = new Date(until);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * AD_DETAIL + AD_CONVERSION_DETAIL 데이터를 수집하여 다차원 집계
 */
async function collectDetailData(client, dateRange) {
  const dates = getDatesBetween(dateRange.since, dateRange.until);
  const rawAdDetail = [];
  const rawConvDetail = [];

  for (const dt of dates) {
    try {
      const rows = await client.createAndDownloadStatReport('AD_DETAIL', dt);
      rawAdDetail.push(...rows.map(r => ({ date: dt, cols: r })));
    } catch (e) { console.log(`AD_DETAIL 실패 (${dt}):`, e.message); }

    try {
      const rows = await client.createAndDownloadStatReport('AD_CONVERSION_DETAIL', dt);
      rawConvDetail.push(...rows.map(r => ({ date: dt, cols: r })));
    } catch (e) { /* 전환 데이터 없으면 무시 */ }
  }

  return { rawAdDetail, rawConvDetail };
}

/**
 * AD_DETAIL TSV 컬럼:
 * 0:date, 1:customerId, 2:campaignId, 3:adgroupId, 4:keywordId, 5:adId,
 * 6:businessChannelId, 7:hour, 8:code(?), 9:queryGroupId, 10:device(P/M),
 * 11:impressions, 12:clicks, 13:cost, 14:rank, 15:??
 *
 * AD_CONVERSION_DETAIL TSV:
 * 0:date, 1:customerId, 2:campaignId, 3:adgroupId, 4:keywordId, 5:adId,
 * 6:channelId, 7:hour, 8:code, 9:queryId, 10:device, 11:directFlag,
 * 12:convType, 13:convCnt, 14:convAmt
 */
function aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap) {
  // 전환 데이터를 캠페인/광고그룹/디바이스/시간별 집계
  const convMap = {}; // key → { purchaseCnt, purchaseAmt, cartCnt, cartAmt }
  for (const { cols } of rawConvDetail) {
    if (cols.length < 15) continue;
    const campaignId = cols[2];
    const adgroupId = cols[3];
    const device = cols[10] === 'P' ? 'PC' : 'MO';
    const hour = parseInt(cols[7]) || 0;
    const convType = cols[12];
    const cnt = parseInt(cols[13]) || 0;
    const amt = parseInt(cols[14]) || 0;

    const keys = [
      `camp:${campaignId}`,
      `ag:${adgroupId}`,
      `device:${device}`,
      `hour:${hour}`,
      `total`,
    ];
    for (const key of keys) {
      if (!convMap[key]) convMap[key] = { purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };
      if (convType === 'purchase' || convType === 'purchase_complete' || convType === 'complete_purchase') {
        convMap[key].purchaseCnt += cnt;
        convMap[key].purchaseAmt += amt;
      } else if (convType === 'add_to_cart') {
        convMap[key].cartCnt += cnt;
        convMap[key].cartAmt += amt;
      }
    }
  }

  // AD_DETAIL 집계
  const byCampaign = {};
  const byAdgroup = {};
  const byDevice = {};
  const byHour = {};
  const byDate = {};
  const total = { imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };

  for (const { date, cols } of rawAdDetail) {
    if (cols.length < 12) continue;
    const campaignId = cols[2];
    const adgroupId = cols[3];
    const device = cols[10] === 'P' ? 'PC' : 'MO';
    const hour = parseInt(cols[7]) || 0;
    const imp = parseInt(cols[11]) || 0;
    const clk = parseInt(cols[12]) || 0;
    const cost = parseInt(cols[13]) || 0;
    const rank = parseFloat(cols[14]) || 0;

    // 전체 합산
    total.imp += imp;
    total.clk += clk;
    total.cost += cost;
    if (rank > 0) { total.rankSum += rank * imp; total.rankCount += imp; }

    // 캠페인별
    if (!byCampaign[campaignId]) byCampaign[campaignId] = { name: campNameMap[campaignId] || campaignId, imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byCampaign[campaignId].imp += imp;
    byCampaign[campaignId].clk += clk;
    byCampaign[campaignId].cost += cost;
    if (rank > 0) { byCampaign[campaignId].rankSum += rank * imp; byCampaign[campaignId].rankCount += imp; }

    // 광고그룹별
    if (!byAdgroup[adgroupId]) byAdgroup[adgroupId] = { name: agNameMap[adgroupId] || adgroupId, campaignName: campNameMap[campaignId] || '', imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byAdgroup[adgroupId].imp += imp;
    byAdgroup[adgroupId].clk += clk;
    byAdgroup[adgroupId].cost += cost;
    if (rank > 0) { byAdgroup[adgroupId].rankSum += rank * imp; byAdgroup[adgroupId].rankCount += imp; }

    // 디바이스별
    if (!byDevice[device]) byDevice[device] = { imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byDevice[device].imp += imp;
    byDevice[device].clk += clk;
    byDevice[device].cost += cost;
    if (rank > 0) { byDevice[device].rankSum += rank * imp; byDevice[device].rankCount += imp; }

    // 시간대별
    const hKey = String(hour).padStart(2, '0');
    if (!byHour[hKey]) byHour[hKey] = { imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byHour[hKey].imp += imp;
    byHour[hKey].clk += clk;
    byHour[hKey].cost += cost;
    if (rank > 0) { byHour[hKey].rankSum += rank * imp; byHour[hKey].rankCount += imp; }

    // 일자별
    if (!byDate[date]) byDate[date] = { imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byDate[date].imp += imp;
    byDate[date].clk += clk;
    byDate[date].cost += cost;
    if (rank > 0) { byDate[date].rankSum += rank * imp; byDate[date].rankCount += imp; }
  }

  // 계산 필드 추가 헬퍼
  function enrich(obj, convKey) {
    const conv = convMap[convKey] || { purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };
    obj.cpc = obj.clk > 0 ? Math.round(obj.cost / obj.clk) : 0;
    obj.ctr = obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0;
    obj.avgRank = obj.rankCount > 0 ? (obj.rankSum / obj.rankCount) : 0;
    obj.purchaseCnt = conv.purchaseCnt;
    obj.purchaseAmt = conv.purchaseAmt;
    obj.cartCnt = conv.cartCnt;
    obj.cartAmt = conv.cartAmt;
    obj.roas = obj.cost > 0 ? Math.round(obj.purchaseAmt / obj.cost * 100) : 0;
    return obj;
  }

  enrich(total, 'total');
  Object.keys(byCampaign).forEach(k => enrich(byCampaign[k], `camp:${k}`));
  Object.keys(byAdgroup).forEach(k => enrich(byAdgroup[k], `ag:${k}`));
  Object.keys(byDevice).forEach(k => enrich(byDevice[k], `device:${k}`));
  Object.keys(byHour).forEach(k => enrich(byHour[k], `hour:${parseInt(k)}`));
  Object.keys(byDate).forEach(k => enrich(byDate[k], ''));

  return { total, byCampaign, byAdgroup, byDevice, byHour, byDate };
}

/**
 * @param {object} account - DB의 ad_accounts + users JOIN 결과
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
    const dateRange = getDateRange(type);
    const period = getPeriodLabel(type, dateRange);

    // 1. 캠페인/광고그룹 이름 매핑 구축
    const campaigns = await client.getCampaigns().catch(() => []);
    const campNameMap = {};
    const agNameMap = {};
    for (const c of (campaigns || [])) {
      campNameMap[c.nccCampaignId] = c.name;
      try {
        const ags = await client.getAdGroups(c.nccCampaignId);
        for (const ag of (ags || [])) {
          agNameMap[ag.nccAdgroupId] = ag.name;
        }
      } catch (e) {}
    }

    // 2. AD_DETAIL + AD_CONVERSION_DETAIL 수집
    const { rawAdDetail, rawConvDetail } = await collectDetailData(client, dateRange);

    // 3. 다차원 집계
    const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap);

    // 4. 이전 기간 데이터 (일간만)
    let prevData = null;
    if (type === 'daily') {
      const d = new Date(dateRange.since);
      d.setDate(d.getDate() - 1);
      const prevDate = d.toISOString().slice(0, 10);
      try {
        const { rawAdDetail: pAd, rawConvDetail: pConv } = await collectDetailData(client, { since: prevDate, until: prevDate });
        prevData = aggregateData(pAd, pConv, campNameMap, agNameMap);
      } catch (e) {}
    }

    // 5. 리포트 발송
    await sendReport({
      account,
      type,
      period,
      data,
      prevData,
    });

    console.log(`✅ [${account.name}] ${type.toUpperCase()} 완료`);
    return true;
  } catch (err) {
    console.error(`❌ [${account.name}] ${type.toUpperCase()} 오류:`, err.message);
    return false;
  }
}

/**
 * 미리보기용 HTML 생성 (이메일 발송 없이)
 */
async function generatePreview(account, type) {
  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  const dateRange = getDateRange(type);
  const period = getPeriodLabel(type, dateRange);

  const campaigns = await client.getCampaigns().catch(() => []);
  const campNameMap = {};
  const agNameMap = {};
  for (const c of (campaigns || [])) {
    campNameMap[c.nccCampaignId] = c.name;
    try {
      const ags = await client.getAdGroups(c.nccCampaignId);
      for (const ag of (ags || [])) agNameMap[ag.nccAdgroupId] = ag.name;
    } catch (e) {}
  }

  const { rawAdDetail, rawConvDetail } = await collectDetailData(client, dateRange);
  const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap);

  // 이전 기간
  let prevData = null;
  if (type === 'daily') {
    const d = new Date(dateRange.since);
    d.setDate(d.getDate() - 1);
    const prevDate = d.toISOString().slice(0, 10);
    try {
      const { rawAdDetail: pAd, rawConvDetail: pConv } = await collectDetailData(client, { since: prevDate, until: prevDate });
      prevData = aggregateData(pAd, pConv, campNameMap, agNameMap);
    } catch (e) {}
  }

  const { buildHtmlReport } = require('../email/sender');
  return buildHtmlReport({ type, period, accountName: account.name, data, prevData });
}

module.exports = { generateAndSend, generatePreview };
