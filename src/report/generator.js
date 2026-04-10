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
 * SHOPPINGKEYWORD_DETAIL (13열) → AD_DETAIL (15열) 컬럼 리매핑
 * Shopping rows는 adId(5), channelId(6) 컬럼이 없음 → 빈 값 삽입
 */
function remapShoppingRow(cols) {
  if (cols.length >= 15) return cols; // 이미 15열 이상이면 그대로
  // [0:date, 1:custId, 2:campId, 3:agId, 4:kwId, 5:hour, 6:code, 7:queryGrpId, 8:device, 9:imp, 10:clk, 11:cost, 12:rank]
  // → [0:date, 1:custId, 2:campId, 3:agId, 4:kwId, '','', 5:hour, 6:code, 7:queryGrpId, 8:device, 9:imp, 10:clk, 11:cost, 12:rank]
  return [...cols.slice(0, 5), '', '', ...cols.slice(5)];
}

/**
 * AD_DETAIL + AD_CONVERSION_DETAIL 데이터를 수집하여 다차원 집계
 *
 * 핵심: AD_DETAIL은 전체 성과(총합) 용도로 필터 없이 사용하고,
 * SHOPPINGKEYWORD_DETAIL은 쇼핑 키워드별 분석 용도로만 별도 저장한다.
 * (이전에는 keywordId='-' 행을 모두 제거해 파워링크+쇼핑 데이터 손실이 발생)
 */
async function collectDetailData(client, dateRange) {
  const dates = getDatesBetween(dateRange.since, dateRange.until);
  const rawAdDetail = [];
  const rawConvDetail = [];
  const rawShopKwDetail = [];
  const rawShopConvDetail = [];

  // 날짜별 3개씩 병렬 처리 (API 부하 완화 + 속도 개선)
  const BATCH_SIZE = 3;
  for (let i = 0; i < dates.length; i += BATCH_SIZE) {
    const batch = dates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (dt) => {
        const [adResult, convResult, shopResult, shopConvResult] = await Promise.allSettled([
          client.createAndDownloadStatReport('AD_DETAIL', dt),
          client.createAndDownloadStatReport('AD_CONVERSION_DETAIL', dt),
          client.createAndDownloadStatReport('SHOPPINGKEYWORD_DETAIL', dt),
          client.createAndDownloadStatReport('SHOPPINGKEYWORD_CONVERSION_DETAIL', dt),
        ]);

        // AD_DETAIL: 전체 성과 데이터 (파워링크+쇼핑 모두 포함, 필터 없음)
        const adRows = adResult.status === 'fulfilled' ? adResult.value : [];
        if (adResult.status === 'rejected') console.log(`AD_DETAIL 실패 (${dt}):`, adResult.reason?.message);

        // AD_CONVERSION_DETAIL: 전체 전환 데이터 (필터 없음)
        const convRows = convResult.status === 'fulfilled' ? convResult.value : [];

        // SHOPPINGKEYWORD_DETAIL: 쇼핑 키워드별 분석 전용 (리매핑만, 총합에는 미반영)
        let shopKwRows = [];
        if (shopResult.status === 'fulfilled' && shopResult.value.length > 0) {
          shopKwRows = shopResult.value.map(remapShoppingRow);
        }

        // SHOPPINGKEYWORD_CONVERSION_DETAIL: 쇼핑 키워드별 전환 전용
        let shopConvRows = [];
        if (shopConvResult.status === 'fulfilled' && shopConvResult.value.length > 0) {
          shopConvRows = shopConvResult.value.map(remapShoppingRow);
        }

        return { dt, adRows, convRows, shopKwRows, shopConvRows };
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        const { dt, adRows, convRows, shopKwRows, shopConvRows } = result.value;
        rawAdDetail.push(...adRows.map(r => ({ date: dt, cols: r })));
        rawConvDetail.push(...convRows.map(r => ({ date: dt, cols: r })));
        rawShopKwDetail.push(...shopKwRows.map(r => ({ date: dt, cols: r })));
        rawShopConvDetail.push(...shopConvRows.map(r => ({ date: dt, cols: r })));
      } else {
        console.log(`배치 처리 실패:`, result.reason?.message);
      }
    }
  }

  return { rawAdDetail, rawConvDetail, rawShopKwDetail, rawShopConvDetail };
}

/**
 * 이전 기간 날짜 범위 계산
 */
function getPrevDateRange(type, dateRange) {
  if (type === 'daily') {
    const d = new Date(dateRange.since);
    d.setDate(d.getDate() - 1);
    const prev = d.toISOString().slice(0, 10);
    return { since: prev, until: prev };
  }
  if (type === 'weekly') {
    // 전주: 현재 주간 범위에서 7일 전
    const prevSince = new Date(dateRange.since);
    prevSince.setDate(prevSince.getDate() - 7);
    const prevUntil = new Date(dateRange.until);
    prevUntil.setDate(prevUntil.getDate() - 7);
    return { since: prevSince.toISOString().slice(0, 10), until: prevUntil.toISOString().slice(0, 10) };
  }
  if (type === 'monthly') {
    // 전전월: 현재 리포트가 전월이므로 그 이전 달
    const currStart = new Date(dateRange.since);
    const prevEnd = new Date(currStart);
    prevEnd.setDate(prevEnd.getDate() - 1); // 전전월 마지막일
    const prevStart = new Date(prevEnd.getFullYear(), prevEnd.getMonth(), 1);
    return { since: prevStart.toISOString().slice(0, 10), until: prevEnd.toISOString().slice(0, 10) };
  }
  return null;
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
function aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap) {
  campTypeMap = campTypeMap || {};
  kwNameMap = kwNameMap || {};
  kwQiMap = kwQiMap || {};

  // 캠페인 유형 라벨 (네이버 SA API 공식 campaignTp 값)
  // 1=WEB_SITE(파워링크), 2=SHOPPING(쇼핑검색), 3=POWER_CONTENTS(파워콘텐츠), 4=BRAND(브랜드검색), 6=LOCAL_SMB(로컬)
  const typeLabels = {
    '1': '파워링크', 'WEB_SITE': '파워링크',
    '2': '쇼핑검색', 'SHOPPING': '쇼핑검색',
    '3': '파워콘텐츠', 'POWER_CONTENTS': '파워콘텐츠',
    '4': '브랜드검색', 'BRAND': '브랜드검색', 'BRAND_SEARCH': '브랜드검색',
    '6': '로컬', 'LOCAL_SMB': '로컬',
  };
  function getCampTypeLabel(campaignId) {
    const tp = String(campTypeMap[campaignId] || '1');
    return typeLabels[tp] || `기타(${tp})`;
  }
  function isShopping(campaignId) {
    const tp = String(campTypeMap[campaignId] || '1');
    return tp === '2' || tp === 'SHOPPING';
  }

  // 전환 데이터를 캠페인/광고그룹/디바이스/시간별/키워드별 집계
  const convMap = {}; // key → { purchaseCnt, purchaseAmt, cartCnt, cartAmt }
  const convTypeSet = new Set(); // 디버깅: 실제 convType 값 수집
  for (const { date: convDate, cols } of rawConvDetail) {
    if (cols.length < 15) continue;
    const campaignId = cols[2];
    const adgroupId = cols[3];
    const keywordId = cols[4];
    const device = cols[10] === 'P' ? 'PC' : 'MO';
    const hour = parseInt(cols[7]) || 0;
    const convType = cols[12];
    const cnt = parseInt(cols[13]) || 0;
    const amt = parseInt(cols[14]) || 0;
    const campType = getCampTypeLabel(campaignId);

    convTypeSet.add(convType);

    // 구매 전환 판별 (다양한 형식 대응)
    const convTypeLower = (convType || '').toLowerCase();
    const isPurchase = convTypeLower === 'purchase' || convTypeLower === 'purchase_complete' || convTypeLower === 'complete_purchase'
      || convTypeLower === 'conversion' || convTypeLower === 'conv' || convTypeLower === '1';
    const isCart = convTypeLower === 'add_to_cart' || convTypeLower === 'cart' || convTypeLower === 'add_cart';

    const convKwKey = (keywordId && keywordId !== '-') ? `kw:${keywordId}` : `ag:${adgroupId}`;
    const keys = [
      `camp:${campaignId}`,
      `ag:${adgroupId}`,
      `device:${device}`,
      `hour:${hour}`,
      convKwKey,
      `campType:${campType}`,
      `total`,
      `date:${convDate}`,
    ];
    for (const key of keys) {
      if (!convMap[key]) convMap[key] = { purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };
      if (isPurchase) {
        convMap[key].purchaseCnt += cnt;
        convMap[key].purchaseAmt += amt;
      } else if (isCart) {
        convMap[key].cartCnt += cnt;
        convMap[key].cartAmt += amt;
      }
    }
  }
  // SHOPPINGKEYWORD_CONVERSION_DETAIL → 쇼핑 키워드별 전환만 convMap에 추가 (kw: 키만)
  for (const { cols } of (rawShopConvDetail || [])) {
    if (cols.length < 15) continue;
    const keywordId = cols[4];
    if (!keywordId || keywordId === '-' || keywordId === '') continue;
    const convType = cols[12];
    const cnt = parseInt(cols[13]) || 0;
    const amt = parseInt(cols[14]) || 0;
    const convTypeLower = (convType || '').toLowerCase();
    const isPurchase = convTypeLower === 'purchase' || convTypeLower === 'purchase_complete' || convTypeLower === 'complete_purchase'
      || convTypeLower === 'conversion' || convTypeLower === 'conv' || convTypeLower === '1';
    const isCart = convTypeLower === 'add_to_cart' || convTypeLower === 'cart' || convTypeLower === 'add_cart';
    const key = `kw:${keywordId}`;
    if (!convMap[key]) convMap[key] = { purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };
    if (isPurchase) { convMap[key].purchaseCnt += cnt; convMap[key].purchaseAmt += amt; }
    else if (isCart) { convMap[key].cartCnt += cnt; convMap[key].cartAmt += amt; }
  }

  if (convTypeSet.size > 0) console.log(`  📊 전환 타입 목록: ${[...convTypeSet].join(', ')}`);
  if (rawConvDetail.length > 0) console.log(`  📊 전환 행 수: ${rawConvDetail.length}, convMap keys: ${Object.keys(convMap).length}`);

  // AD_DETAIL 집계
  const byCampaign = {};
  const byAdgroup = {};
  const byDevice = {};
  const byHour = {};
  const byDate = {};
  const byKeyword = {};
  const byCampaignType = {};
  const total = { imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };

  for (const { date, cols } of rawAdDetail) {
    if (cols.length < 12) continue;
    const campaignId = cols[2];
    const adgroupId = cols[3];
    const keywordId = cols[4];
    const device = cols[10] === 'P' ? 'PC' : 'MO';
    const hour = parseInt(cols[7]) || 0;
    const imp = parseInt(cols[11]) || 0;
    const clk = parseInt(cols[12]) || 0;
    const cost = parseInt(cols[13]) || 0;
    const rank = parseFloat(cols[14]) || 0;
    const campType = getCampTypeLabel(campaignId);

    // 전체 합산
    total.imp += imp;
    total.clk += clk;
    total.cost += cost;
    if (rank > 0) { total.rankSum += rank * imp; total.rankCount += imp; }

    // 캠페인별
    if (!byCampaign[campaignId]) byCampaign[campaignId] = { name: campNameMap[campaignId] || campaignId, campaignType: campType, imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byCampaign[campaignId].imp += imp;
    byCampaign[campaignId].clk += clk;
    byCampaign[campaignId].cost += cost;
    if (rank > 0) { byCampaign[campaignId].rankSum += rank * imp; byCampaign[campaignId].rankCount += imp; }

    // 캠페인 유형별
    if (!byCampaignType[campType]) byCampaignType[campType] = { imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byCampaignType[campType].imp += imp;
    byCampaignType[campType].clk += clk;
    byCampaignType[campType].cost += cost;
    if (rank > 0) { byCampaignType[campType].rankSum += rank * imp; byCampaignType[campType].rankCount += imp; }

    // 광고그룹별
    if (!byAdgroup[adgroupId]) byAdgroup[adgroupId] = { name: agNameMap[adgroupId] || adgroupId, campaignName: campNameMap[campaignId] || '', campaignType: campType, imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0 };
    byAdgroup[adgroupId].imp += imp;
    byAdgroup[adgroupId].clk += clk;
    byAdgroup[adgroupId].cost += cost;
    if (rank > 0) { byAdgroup[adgroupId].rankSum += rank * imp; byAdgroup[adgroupId].rankCount += imp; }

    // 키워드별 (SHOPPINGKEYWORD_DETAIL 사용 시 cols[4]에 검색어 텍스트)
    if (keywordId && keywordId !== '0' && keywordId !== '' && keywordId !== '-') {
      const kwKey = `kw:${keywordId}`;
      if (!byKeyword[kwKey]) byKeyword[kwKey] = {
        name: kwNameMap[keywordId] || keywordId,
        campaignName: campNameMap[campaignId] || '',
        adgroupName: agNameMap[adgroupId] || '',
        campaignType: campType,
        qi: kwQiMap[keywordId] || 0,
        imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0,
      };
      byKeyword[kwKey].imp += imp;
      byKeyword[kwKey].clk += clk;
      byKeyword[kwKey].cost += cost;
      if (rank > 0) { byKeyword[kwKey].rankSum += rank * imp; byKeyword[kwKey].rankCount += imp; }
    }

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

  // SHOPPINGKEYWORD_DETAIL → 쇼핑 키워드별 성과 (키워드 분석용으로만 사용, 총합에 미반영)
  for (const { date, cols } of (rawShopKwDetail || [])) {
    if (cols.length < 15) continue;
    const campaignId = cols[2];
    const adgroupId = cols[3];
    const keywordId = cols[4];
    if (!keywordId || keywordId === '-' || keywordId === '0' || keywordId === '') continue;
    const imp = parseInt(cols[11]) || 0;
    const clk = parseInt(cols[12]) || 0;
    const cost = parseInt(cols[13]) || 0;
    const rank = parseFloat(cols[14]) || 0;
    const campType = getCampTypeLabel(campaignId);
    const kwKey = `kw:${keywordId}`;
    if (!byKeyword[kwKey]) byKeyword[kwKey] = {
      name: kwNameMap[keywordId] || keywordId,
      campaignName: campNameMap[campaignId] || '',
      adgroupName: agNameMap[adgroupId] || '',
      campaignType: campType,
      imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0,
    };
    byKeyword[kwKey].imp += imp;
    byKeyword[kwKey].clk += clk;
    byKeyword[kwKey].cost += cost;
    if (rank > 0) { byKeyword[kwKey].rankSum += rank * imp; byKeyword[kwKey].rankCount += imp; }
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
  Object.keys(byCampaignType).forEach(k => enrich(byCampaignType[k], `campType:${k}`));
  Object.keys(byAdgroup).forEach(k => enrich(byAdgroup[k], `ag:${k}`));
  Object.keys(byKeyword).forEach(k => enrich(byKeyword[k], k));
  Object.keys(byDevice).forEach(k => enrich(byDevice[k], `device:${k}`));
  Object.keys(byHour).forEach(k => enrich(byHour[k], `hour:${parseInt(k)}`));
  Object.keys(byDate).forEach(k => enrich(byDate[k], `date:${k}`));

  return { total, byCampaign, byCampaignType, byAdgroup, byKeyword, byDevice, byHour, byDate };
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

    // 1. 마스터 리포트 API로 전체 캠페인/광고그룹/키워드 이름 매핑 (빠른 벌크 다운로드)
    const campNameMap = {};
    const campTypeMap = {};
    const agNameMap = {};
    const kwNameMap = {};
    const kwQiMap = {};
    try {
      const [campRows, agRows, kwRows, qiRows] = await Promise.all([
        client.syncMaster('Campaign').catch(() => []),
        client.syncMaster('Adgroup').catch(() => []),
        client.syncMaster('Keyword').catch(() => []),
        client.syncMaster('Qi').catch(() => []),
      ]);
      for (const r of campRows) {
        if (r.length < 3) continue;
        campNameMap[r[1]] = r[2];
        campTypeMap[r[1]] = parseInt(r[3]) || 1;
      }
      // 광고그룹 TSV: [0]customerId, [1]adgroupId, [2]campaignId, [3]adgroupName
      for (const r of agRows) {
        if (r.length < 4) continue;
        agNameMap[r[1]] = r[3];
      }
      // 키워드 TSV: [0]customerId, [1]adgroupId, [2]keywordId, [3]keyword(텍스트)
      for (const r of kwRows) {
        if (r.length < 4) continue;
        kwNameMap[r[2]] = r[3];
      }
      // Qi TSV: [0]customerId, [1]keywordId, [2]qi(1~7)
      for (const r of qiRows) {
        if (r.length < 3) continue;
        kwQiMap[r[1]] = parseInt(r[2]) || 0;
      }
      console.log(`  📋 마스터 리포트 매핑: 캠페인 ${campRows.length}, 그룹 ${agRows.length}, 키워드 ${kwRows.length}, Qi ${qiRows.length}`);
    } catch (e) {
      console.log('  ⚠️ 마스터 리포트 매핑 실패:', e.message);
    }

    // 2. AD_DETAIL + AD_CONVERSION_DETAIL + SHOPPINGKEYWORD 수집
    const { rawAdDetail, rawConvDetail, rawShopKwDetail, rawShopConvDetail } = await collectDetailData(client, dateRange);

    // 3. 다차원 집계
    const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap);

    // 4. 이전 기간 데이터 (일간/주간/월간 모두)
    let prevData = null;
    const prevRange = getPrevDateRange(type, dateRange);
    if (prevRange) {
      const prevLabel = { daily: '전일', weekly: '전주', monthly: '전전월' }[type];
      console.log(`  📊 ${prevLabel} 데이터 수집: ${prevRange.since} ~ ${prevRange.until}`);
      try {
        const prev = await collectDetailData(client, prevRange);
        prevData = aggregateData(prev.rawAdDetail, prev.rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, prev.rawShopKwDetail, prev.rawShopConvDetail);
        console.log(`  ✅ ${prevLabel} 데이터 완료: ${prev.rawAdDetail.length}건`);
      } catch (e) {
        console.log(`  ⚠️ ${prevLabel} 데이터 실패:`, e.message);
      }
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
    console.error(`❌ [${account.name}] ${type.toUpperCase()} 오류:`, err.message, err.stack);
    // 에러를 throw하여 상위에서 상세 메시지 전달
    throw err;
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

  const campNameMap = {};
  const campTypeMap = {};
  const agNameMap = {};
  const kwNameMap = {};
  const kwQiMap = {};
  try {
    const [campRows, agRows, kwRows, qiRows] = await Promise.all([
      client.syncMaster('Campaign').catch(() => []),
      client.syncMaster('Adgroup').catch(() => []),
      client.syncMaster('Keyword').catch(() => []),
      client.syncMaster('Qi').catch(() => []),
    ]);
    for (const r of campRows) { if (r.length >= 3) { campNameMap[r[1]] = r[2]; campTypeMap[r[1]] = parseInt(r[3]) || 1; } }
    for (const r of agRows) { if (r.length >= 4) agNameMap[r[1]] = r[3]; }
    for (const r of kwRows) { if (r.length >= 4) kwNameMap[r[2]] = r[3]; }
    for (const r of qiRows) { if (r.length >= 3) kwQiMap[r[1]] = parseInt(r[2]) || 0; }
  } catch (e) {}

  const { rawAdDetail, rawConvDetail, rawShopKwDetail, rawShopConvDetail } = await collectDetailData(client, dateRange);
  const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap);

  // 이전 기간 (일간/주간/월간 모두)
  let prevData = null;
  const prevRange = getPrevDateRange(type, dateRange);
  if (prevRange) {
    try {
      const prev = await collectDetailData(client, prevRange);
      prevData = aggregateData(prev.rawAdDetail, prev.rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, prev.rawShopKwDetail, prev.rawShopConvDetail, kwQiMap);
    } catch (e) {}
  }

  const { buildHtmlReport } = require('../email/sender');
  return buildHtmlReport({ type, period, accountName: account.name, data, prevData });
}

module.exports = { generateAndSend, generatePreview };
