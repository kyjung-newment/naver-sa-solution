const { createApiClient } = require('../api/naverApi');
const { sendReport } = require('../email/sender');
const db = require('../db/database');

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
 * SHOPPINGKEYWORD_DETAIL / SHOPPINGKEYWORD_CONVERSION_DETAIL 컬럼 리매핑
 * 실제 TSV 형식 (16열/15열):
 *   SHOPPINGKEYWORD_DETAIL (16열): date, custId, campId, agId, keyword(TEXT), adId, bsnId, hour, code, queryGrpId, device, imp, clk, cost, rank, ?
 *   SHOPPINGKEYWORD_CONVERSION_DETAIL (15열): date, custId, campId, agId, keyword(TEXT), adId, bsnId, hour, code, queryGrpId, device, directFlag, convType, convCnt, convAmt
 * AD_DETAIL과 동일한 컬럼 위치(11=imp, 12=clk, 13=cost, 14=rank / 12=convType, 13=convCnt, 14=convAmt)를 가지므로
 * 15열 이상이면 리매핑 불필요
 */
function remapShoppingRow(cols) {
  if (cols.length >= 15) return cols; // 실제 형식은 15-16열이므로 그대로 반환
  // 만약 13열 이하인 레거시 형식이 올 경우를 위한 안전장치
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
  const rawQueryDetail = [];

  // 날짜별 5개씩 병렬 처리 (Naver API 부하 + 메모리 균형)
  const BATCH_SIZE = 5;
  for (let i = 0; i < dates.length; i += BATCH_SIZE) {
    const batch = dates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (dt) => {
        const [adResult, convResult, shopResult, shopConvResult, queryResult] = await Promise.allSettled([
          client.createAndDownloadStatReport('AD_DETAIL', dt),
          client.createAndDownloadStatReport('AD_CONVERSION_DETAIL', dt),
          client.createAndDownloadStatReport('SHOPPINGKEYWORD_DETAIL', dt),
          client.createAndDownloadStatReport('SHOPPINGKEYWORD_CONVERSION_DETAIL', dt),
          client.createAndDownloadStatReport('AD_QUERY_DETAIL', dt),
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

        // AD_QUERY_DETAIL: 검색어 텍스트 포함 (마스터 sync 의존 X)
        const queryRows = queryResult.status === 'fulfilled' ? queryResult.value : [];
        if (queryResult.status === 'rejected') console.log(`AD_QUERY_DETAIL 실패 (${dt}):`, queryResult.reason?.message);

        return { dt, adRows, convRows, shopKwRows, shopConvRows, queryRows };
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        const { dt, adRows, convRows, shopKwRows, shopConvRows, queryRows } = result.value;
        // AD_DETAIL: imp+clk+cost 모두 0인 행은 메모리 절감 위해 즉시 제외
        // (전환은 별도 테이블에 있으므로 이 행들은 정말 의미 없는 노이즈)
        for (const r of adRows) {
          if (r.length < 14) continue;
          const imp = parseInt(r[11]) || 0, clk = parseInt(r[12]) || 0, cost = parseInt(r[13]) || 0;
          if (imp === 0 && clk === 0 && cost === 0) continue;
          rawAdDetail.push({ date: dt, cols: r });
        }
        // CONVERSION은 전부 보존 (전환 발생 = 중요)
        rawConvDetail.push(...convRows.map(r => ({ date: dt, cols: r })));
        // SHOPPINGKEYWORD_DETAIL도 imp+clk+cost 0이면 제외
        for (const r of shopKwRows) {
          if (r.length < 14) continue;
          const imp = parseInt(r[11]) || 0, clk = parseInt(r[12]) || 0, cost = parseInt(r[13]) || 0;
          if (imp === 0 && clk === 0 && cost === 0) continue;
          rawShopKwDetail.push({ date: dt, cols: r });
        }
        rawShopConvDetail.push(...shopConvRows.map(r => ({ date: dt, cols: r })));

        // AD_QUERY_DETAIL: 검색어 텍스트 포함, 0 노출/클릭/비용 행 제외
        // TSV 컬럼 위치는 환경마다 다를 수 있어 parseQueryRow에서 휴리스틱 파싱
        for (const r of (queryRows || [])) {
          if (!Array.isArray(r) || r.length < 6) continue;
          const parsed = parseQueryRow(r);
          if (!parsed) continue;
          if (parsed.imp === 0 && parsed.clk === 0 && parsed.cost === 0) continue;
          rawQueryDetail.push({ date: dt, ...parsed });
        }
      } else {
        console.log(`배치 처리 실패:`, result.reason?.message);
      }
    }
  }

  return { rawAdDetail, rawConvDetail, rawShopKwDetail, rawShopConvDetail, rawQueryDetail };
}

/**
 * AD_QUERY_DETAIL TSV 파서 (휴리스틱)
 * Naver SA에서 컬럼 구조가 변경될 가능성이 있어 안전하게 파싱:
 * - 앞 5컬럼은 date/customerId/campaignId/adgroupId/keywordId 로 가정
 * - 검색어(query)는 숫자/ID/날짜/단일문자가 아닌 텍스트 컬럼
 * - imp/clk/cost는 query 컬럼 다음 3개 정수
 */
function parseQueryRow(cols) {
  if (!cols || cols.length < 6) return null;
  // 검색어 텍스트 컬럼 찾기 (오른쪽에서 왼쪽 스캔)
  let queryCol = -1;
  for (let i = cols.length - 1; i >= 5; i--) {
    const v = (cols[i] || '').trim();
    if (!v) continue;
    if (/^-?\d+(\.\d+)?$/.test(v)) continue; // 숫자
    if (/^(nkw|ncc|nad|nccad|cmp|adg|biz|cnv)[-_]/i.test(v)) continue; // ID
    if (/^\d{8}$/.test(v)) continue; // 날짜
    if (v.length === 1) continue; // 디바이스 코드(P/M)
    queryCol = i;
    break;
  }
  if (queryCol === -1) return null;
  const query = (cols[queryCol] || '').trim();
  if (!query) return null;
  // imp/clk/cost는 query 다음 3개로 추정
  const imp = parseInt(cols[queryCol + 1]) || 0;
  const clk = parseInt(cols[queryCol + 2]) || 0;
  const cost = parseInt(cols[queryCol + 3]) || 0;
  return {
    campaignId: cols[2],
    adgroupId: cols[3],
    keywordId: cols[4],
    query,
    imp, clk, cost,
  };
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
    // 전전월: 현재 리포트가 전월이므로 그 이전 달 (UTC 기준 타임존 안전)
    const currStart = new Date(dateRange.since + 'T00:00:00Z');
    const prevEnd = new Date(currStart);
    prevEnd.setUTCDate(prevEnd.getUTCDate() - 1); // 전전월 마지막일
    const prevStart = new Date(Date.UTC(prevEnd.getUTCFullYear(), prevEnd.getUTCMonth(), 1));
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
function aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap, rawQueryDetail) {
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

    // 구매 전환 판별 (영문 + 한국어 + 코드 대응)
    const convTypeLower = (convType || '').toLowerCase();
    const convTypeRaw = (convType || '').trim();
    const isPurchase = convTypeLower === 'purchase' || convTypeLower === 'purchase_complete' || convTypeLower === 'complete_purchase'
      || convTypeLower === 'conversion' || convTypeLower === 'conv' || convTypeLower === '1'
      || convTypeRaw === '구매완료';
    const isCart = convTypeLower === 'add_to_cart' || convTypeLower === 'cart' || convTypeLower === 'add_cart'
      || convTypeRaw === '장바구니 담기' || convTypeRaw === '장바구니';

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
    const convTypeRaw2 = (convType || '').trim();
    const isPurchase = convTypeLower === 'purchase' || convTypeLower === 'purchase_complete' || convTypeLower === 'complete_purchase'
      || convTypeLower === 'conversion' || convTypeLower === 'conv' || convTypeLower === '1'
      || convTypeRaw2 === '구매완료';
    const isCart = convTypeLower === 'add_to_cart' || convTypeLower === 'cart' || convTypeLower === 'add_cart'
      || convTypeRaw2 === '장바구니 담기' || convTypeRaw2 === '장바구니';
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

  // 메모리/Excel 사이즈 절감: 노출 0인 키워드 제거 (전환도 없는 것)
  // imp=0 AND clk=0 AND cost=0 AND purchaseCnt=0 AND cartCnt=0인 키워드는 의미 없음
  const beforeKwCount = Object.keys(byKeyword).length;
  for (const k of Object.keys(byKeyword)) {
    const d = byKeyword[k];
    if ((d.imp || 0) === 0 && (d.clk || 0) === 0 && (d.cost || 0) === 0
        && (d.purchaseCnt || 0) === 0 && (d.cartCnt || 0) === 0) {
      delete byKeyword[k];
    }
  }
  const afterKwCount = Object.keys(byKeyword).length;
  if (beforeKwCount !== afterKwCount) {
    console.log(`  🧹 키워드 필터: ${beforeKwCount}개 → ${afterKwCount}개 (0 노출/전환 ${beforeKwCount-afterKwCount}개 제거)`);
  }

  // ─── byQuery: AD_QUERY_DETAIL 기반 검색어별 집계 (마스터 sync 의존 X) ───
  const byQuery = {};
  for (const item of (rawQueryDetail || [])) {
    const { campaignId, adgroupId, query, imp, clk, cost } = item;
    if (!query) continue;
    const campType = getCampTypeLabel(campaignId);
    const key = `q:${adgroupId}|${query}`;
    if (!byQuery[key]) byQuery[key] = {
      name: query,
      campaignName: campNameMap[campaignId] || '',
      adgroupName: agNameMap[adgroupId] || '',
      campaignType: campType,
      imp: 0, clk: 0, cost: 0,
      purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0,
      rankSum: 0, rankCount: 0,
    };
    byQuery[key].imp += imp;
    byQuery[key].clk += clk;
    byQuery[key].cost += cost;
  }
  Object.keys(byQuery).forEach(k => {
    const d = byQuery[k];
    d.cpc = d.clk > 0 ? Math.round(d.cost / d.clk) : 0;
    d.ctr = d.imp > 0 ? (d.clk / d.imp * 100) : 0;
    d.avgRank = 0;
    d.roas = 0;
  });
  if (Object.keys(byQuery).length > 0) {
    console.log(`  🔍 AD_QUERY_DETAIL 검색어별 ${Object.keys(byQuery).length}개 집계`);
  }

  return { total, byCampaign, byCampaignType, byAdgroup, byKeyword, byDevice, byHour, byDate, byQuery };
}

/**
 * Stats API를 활용하여 AD_DETAIL TSV 집계 데이터를 네이버 SA 대시보드와 일치하도록 보정
 * - Stats API는 네이버 검색광고 대시보드와 동일한 데이터 소스를 사용
 * - AD_DETAIL TSV는 세부 분석(시간대/키워드/디바이스)에만 사용하고
 *   총합·캠페인별 숫자는 Stats API로 교정
 */
async function calibrateWithStatsApi(data, client, dateRange) {
  try {
    const stats = await client.getStats({
      startDate: dateRange.since,
      endDate: dateRange.until,
    });

    if (!stats || !stats.campStats) {
      console.log('  ⚠️ Stats API 보정 실패: 데이터 없음');
      return data;
    }

    console.log(`  🔄 Stats API 보정 시작: TSV 총합 imp=${data.total.imp}, clk=${data.total.clk}, cost=${data.total.cost}`);
    console.log(`  🔄 Stats API 실제값:      imp=${stats.impCnt}, clk=${stats.clkCnt}, cost=${stats.salesAmt}`);

    // 1. 캠페인별 보정 (Stats API 캠페인 ID 매핑)
    const statsByCamp = {};
    for (const cs of stats.campStats) {
      statsByCamp[cs.id] = cs;
    }

    for (const campId of Object.keys(data.byCampaign)) {
      const cs = statsByCamp[campId];
      if (!cs) continue;
      const camp = data.byCampaign[campId];
      camp.imp = cs.impCnt;
      camp.clk = cs.clkCnt;
      camp.cost = cs.salesAmt;
      camp.cpc = cs.clkCnt > 0 ? Math.round(cs.salesAmt / cs.clkCnt) : 0;
      camp.ctr = cs.impCnt > 0 ? (cs.clkCnt / cs.impCnt * 100) : 0;
      if (cs.avgRnk > 0) {
        camp.avgRank = cs.avgRnk;
        camp.rankSum = cs.avgRnk;
        camp.rankCount = 1;
      }
      // 총전환 데이터 보정 (Stats API ccnt/convAmt)
      if (typeof cs.ccnt === 'number') camp.convCnt = cs.ccnt;
      if (typeof cs.convAmt === 'number') camp.convAmt = cs.convAmt;
      // 구매완료 전환 데이터 보정 (Stats API purchaseCcnt/purchaseConvAmt)
      if (typeof cs.purchaseCcnt === 'number') camp.purchaseCnt = cs.purchaseCcnt;
      if (typeof cs.purchaseConvAmt === 'number') camp.purchaseAmt = cs.purchaseConvAmt;
      // ROAS 재계산 (보정된 purchaseAmt 기준)
      camp.roas = camp.cost > 0 ? Math.round((camp.purchaseAmt || 0) / camp.cost * 100) : 0;
    }

    // 2. 총합 보정 (Stats API 합계 → 네이버 대시보드와 동일)
    data.total.imp = stats.impCnt;
    data.total.clk = stats.clkCnt;
    data.total.cost = stats.salesAmt;
    data.total.cpc = stats.clkCnt > 0 ? Math.round(stats.salesAmt / stats.clkCnt) : 0;
    data.total.ctr = stats.impCnt > 0 ? (stats.clkCnt / stats.impCnt * 100) : 0;
    if (stats.avgRnk > 0) data.total.avgRank = stats.avgRnk;
    // 총전환 데이터 (Stats API ccnt/convAmt)
    data.total.convCnt = stats.ccnt || 0;
    data.total.convAmt = stats.convAmt || 0;
    // 구매완료 전환 데이터 (Stats API purchaseCcnt/purchaseConvAmt → 대시보드와 일치)
    data.total.purchaseCnt = stats.purchaseCcnt || 0;
    data.total.purchaseAmt = stats.purchaseConvAmt || 0;
    // ROAS 재계산 (보정된 purchaseAmt 기준)
    data.total.roas = data.total.cost > 0 ? Math.round((data.total.purchaseAmt || 0) / data.total.cost * 100) : 0;

    console.log(`  🔄 구매완료 보정: TSV purchaseCnt → Stats API purchaseCcnt=${stats.purchaseCcnt}, purchaseConvAmt=${stats.purchaseConvAmt}`);

    // 3. 캠페인유형별 재집계 (보정된 byCampaign 기반)
    const newByCampType = {};
    for (const campId of Object.keys(data.byCampaign)) {
      const camp = data.byCampaign[campId];
      const ct = camp.campaignType || '기타';
      if (!newByCampType[ct]) newByCampType[ct] = {
        imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0,
        purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0,
      };
      newByCampType[ct].imp += camp.imp;
      newByCampType[ct].clk += camp.clk;
      newByCampType[ct].cost += camp.cost;
      if (camp.avgRank > 0) {
        newByCampType[ct].rankSum += camp.avgRank;
        newByCampType[ct].rankCount += 1;
      }
      newByCampType[ct].purchaseCnt += camp.purchaseCnt || 0;
      newByCampType[ct].purchaseAmt += camp.purchaseAmt || 0;
      newByCampType[ct].cartCnt += camp.cartCnt || 0;
      newByCampType[ct].cartAmt += camp.cartAmt || 0;
    }
    for (const ct of Object.keys(newByCampType)) {
      const d = newByCampType[ct];
      d.cpc = d.clk > 0 ? Math.round(d.cost / d.clk) : 0;
      d.ctr = d.imp > 0 ? (d.clk / d.imp * 100) : 0;
      d.avgRank = d.rankCount > 0 ? (d.rankSum / d.rankCount) : 0;
      d.roas = d.cost > 0 ? Math.round(d.purchaseAmt / d.cost * 100) : 0;
    }
    data.byCampaignType = newByCampType;

    console.log(`  ✅ Stats API 보정 완료: imp=${data.total.imp}, clk=${data.total.clk}, cost=${data.total.cost}, 구매완료=${data.total.purchaseCnt}건/${data.total.purchaseAmt}원`);
    return data;
  } catch (e) {
    console.log(`  ⚠️ Stats API 보정 실패:`, e.message);
    return data;
  }
}

/**
 * @param {object} account - DB의 ad_accounts + users JOIN 결과
 * @param {'daily'|'weekly'|'monthly'} type
 */
async function generateAndSend(account, type, customRange, opts) {
  opts = opts || {};
  console.log(`\n📊 [${account.name}] ${type.toUpperCase()} 리포트 생성...`);

  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  try {
    const dateRange = customRange && customRange.since && customRange.until ? customRange : getDateRange(type);
    const period = customRange && customRange.since && customRange.until
      ? `${customRange.since.replace(/-/g,'.')} ~ ${customRange.until.replace(/-/g,'.')} (맞춤)`
      : getPeriodLabel(type, dateRange);

    // 1. 이름 매핑: DB 마스터 데이터 우선 → 없으면 API 마스터 리포트 폴백
    const campNameMap = {};
    const campTypeMap = {};
    const agNameMap = {};
    const kwNameMap = {};
    const kwQiMap = {};

    // 1-1. DB에서 마스터 데이터 로드 (빠르고 안정적)
    try {
      const dbMaps = await db.buildKeywordMaps(account.id);
      for (const [campId, info] of Object.entries(dbMaps.campMap || {})) {
        campNameMap[campId] = info.name;
        campTypeMap[campId] = info.tp || 1;
      }
      for (const [agId, info] of Object.entries(dbMaps.agMap || {})) {
        agNameMap[agId] = info.name;
      }
      for (const [kwId, info] of Object.entries(dbMaps.kwMap || {})) {
        kwNameMap[kwId] = info.keyword;
        if (info.qi) kwQiMap[kwId] = info.qi;
      }
      console.log(`  📋 DB 마스터 매핑: 캠페인 ${Object.keys(dbMaps.campMap).length}, 그룹 ${Object.keys(dbMaps.agMap).length}, 키워드 ${Object.keys(dbMaps.kwMap).length}`);
    } catch (e) {
      console.log('  ⚠️ DB 마스터 로드 실패:', e.message);
    }

    // 1-2. API 마스터 리포트로 보완 (타임아웃 3분 — 대용량 계정 5만+ 키워드 대응)
    // 캠페인 매핑이 비어있거나, 키워드 매핑이 적게 채워진 경우 보완
    // 대용량 계정에서는 DB 부분 sync로 인해 일부 keyword name이 ID로 표시되는 이슈 해결
    const initialKwCount = Object.keys(kwNameMap).length;
    const shouldFetchMaster = Object.keys(campNameMap).length === 0
      || initialKwCount === 0
      || initialKwCount < 100; // 적게 sync된 경우도 fresh fetch (대용량 계정 보호)
    if (shouldFetchMaster) {
      try {
        const masterTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('마스터 API 타임아웃')), 180000));
        const masterFetch = Promise.all([
          client.syncMaster('Campaign').catch(() => []),
          client.syncMaster('Adgroup').catch(() => []),
          client.syncMaster('Keyword').catch(() => []),
          client.syncMaster('Qi').catch(() => []),
        ]);
        const [campRows, agRows, kwRows, qiRows] = await Promise.race([masterFetch, masterTimeout]);
        for (const r of campRows) {
          if (r.length < 3) continue;
          campNameMap[r[1]] = r[2];
          campTypeMap[r[1]] = parseInt(r[3]) || 1;
        }
        for (const r of agRows) {
          if (r.length < 4) continue;
          agNameMap[r[1]] = r[3];
        }
        for (const r of kwRows) {
          if (r.length < 4) continue;
          kwNameMap[r[2]] = r[3];
        }
        for (const r of qiRows) {
          if (r.length < 3) continue;
          kwQiMap[r[1]] = parseInt(r[2]) || 0;
        }
        console.log(`  📋 API 마스터 폴백: 캠페인 ${campRows.length}, 그룹 ${agRows.length}, 키워드 ${kwRows.length}, Qi ${qiRows.length}`);

        // DB에 저장 (다음번을 위해)
        try {
          if (campRows.length > 0) await db.upsertMasterCampaigns(account.id, campRows);
          if (agRows.length > 0) await db.upsertMasterAdgroups(account.id, agRows);
          if (kwRows.length > 0) await db.upsertMasterKeywords(account.id, kwRows);
        } catch (_) {}
      } catch (e) {
        console.log('  ⚠️ API 마스터 리포트 매핑 실패:', e.message);
      }
    }

    // 2. AD_DETAIL + AD_CONVERSION_DETAIL + SHOPPINGKEYWORD 수집
    const { rawAdDetail, rawConvDetail, rawShopKwDetail, rawShopConvDetail, rawQueryDetail } = await collectDetailData(client, dateRange);

    // 3. 다차원 집계
    const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap, rawQueryDetail);

    // 3-1. Stats API로 총합·캠페인별 데이터 보정 (네이버 SA 대시보드와 일치)
    await calibrateWithStatsApi(data, client, dateRange);

    // 4. 이전 기간 데이터 (일간/주간/월간 모두)
    // skipPrev 옵션 또는 ENV로 강제 스킵 가능 (cron OOM/타임아웃 방지)
    // 맞춤 기간: 동일 길이 직전 기간
    function getCustomPrevRange2(dr) {
      const since = new Date(dr.since); const until = new Date(dr.until);
      const diffDays = Math.round((until - since) / 86400000) + 1;
      const prevUntil = new Date(since); prevUntil.setDate(prevUntil.getDate() - 1);
      const prevSince = new Date(prevUntil); prevSince.setDate(prevSince.getDate() - (diffDays - 1));
      return { since: prevSince.toISOString().slice(0,10), until: prevUntil.toISOString().slice(0,10) };
    }
    let prevData = null;
    const prevRange = (opts.skipPrev || process.env.SKIP_PREV_DATA === '1') ? null
      : (customRange && customRange.since && customRange.until ? getCustomPrevRange2(customRange) : getPrevDateRange(type, dateRange));
    if (prevRange) {
      const prevLabel = { daily: '전일', weekly: '전주', monthly: '전전월' }[type];
      console.log(`  📊 ${prevLabel} 데이터 수집: ${prevRange.since} ~ ${prevRange.until}`);
      try {
        const prev = await collectDetailData(client, prevRange);
        prevData = aggregateData(prev.rawAdDetail, prev.rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, prev.rawShopKwDetail, prev.rawShopConvDetail, kwQiMap, prev.rawQueryDetail);
        // 이전 기간도 Stats API 보정 적용
        await calibrateWithStatsApi(prevData, client, prevRange);
        console.log(`  ✅ ${prevLabel} 데이터 완료: ${prev.rawAdDetail.length}건`);
      } catch (e) {
        console.log(`  ⚠️ ${prevLabel} 데이터 실패:`, e.message);
      }
    }

    // 5. 리포트 발송
    const isCustom = !!(customRange && customRange.since && customRange.until);
    await sendReport({
      account,
      type,
      period,
      data,
      prevData,
      dateRange,
      prevRange,
      isCustom,
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
 * 리포트 데이터 수집 공통 헬퍼 (preview/excel 공용)
 * - monthly의 경우 30일 + 전전월 30일을 모두 가져오면 5분 초과할 수 있어
 *   타임아웃 가드와 prev 스킵으로 안정성 확보
 */
async function collectReportData(account, type, customRange, opts) {
  opts = opts || {};
  const client = createApiClient({
    apiKey: account.api_key,
    secretKey: account.secret_key,
    customerId: account.customer_id,
  });

  const dateRange = customRange && customRange.since && customRange.until ? customRange : getDateRange(type);
  const period = customRange && customRange.since && customRange.until
    ? `${customRange.since.replace(/-/g,'.')} ~ ${customRange.until.replace(/-/g,'.')} (맞춤)`
    : getPeriodLabel(type, dateRange);

  const campNameMap = {};
  const campTypeMap = {};
  const agNameMap = {};
  const kwNameMap = {};
  const kwQiMap = {};

  // DB 마스터 데이터 우선 로드
  try {
    const dbMaps = await db.buildKeywordMaps(account.id);
    for (const [campId, info] of Object.entries(dbMaps.campMap || {})) { campNameMap[campId] = info.name; campTypeMap[campId] = info.tp || 1; }
    for (const [agId, info] of Object.entries(dbMaps.agMap || {})) { agNameMap[agId] = info.name; }
    for (const [kwId, info] of Object.entries(dbMaps.kwMap || {})) { kwNameMap[kwId] = info.keyword; if (info.qi) kwQiMap[kwId] = info.qi; }
  } catch (_) {}

  // DB에 없으면 API 폴백 (타임아웃 15초)
  if (Object.keys(campNameMap).length === 0) {
    try {
      const masterTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('타임아웃')), 15000));
      const masterFetch = Promise.all([
        client.syncMaster('Campaign').catch(() => []),
        client.syncMaster('Adgroup').catch(() => []),
        client.syncMaster('Keyword').catch(() => []),
        client.syncMaster('Qi').catch(() => []),
      ]);
      const [campRows, agRows, kwRows, qiRows] = await Promise.race([masterFetch, masterTimeout]);
      for (const r of campRows) { if (r.length >= 3) { campNameMap[r[1]] = r[2]; campTypeMap[r[1]] = parseInt(r[3]) || 1; } }
      for (const r of agRows) { if (r.length >= 4) agNameMap[r[1]] = r[3]; }
      for (const r of kwRows) { if (r.length >= 4) kwNameMap[r[2]] = r[3]; }
      for (const r of qiRows) { if (r.length >= 3) kwQiMap[r[1]] = parseInt(r[2]) || 0; }
    } catch (e) {}
  }

  // 전체 타임아웃: monthly 600s / weekly 300s / daily 180s
  const overallTimeout = type === 'monthly' ? 600000 : (type === 'weekly' ? 300000 : 180000);
  const timeoutPromise = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`리포트 생성 시간 초과(${overallTimeout / 1000}s). 데이터가 너무 많거나 API 응답이 느립니다.`)), overallTimeout)
  );

  const collectMain = (async () => {
    const { rawAdDetail, rawConvDetail, rawShopKwDetail, rawShopConvDetail, rawQueryDetail } = await collectDetailData(client, dateRange);
    const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap, rawQueryDetail);
    await calibrateWithStatsApi(data, client, dateRange);
    return data;
  })();

  const data = await Promise.race([collectMain, timeoutPromise]);

  // 이전 기간 데이터: 가능한 만큼만, 실패해도 본 데이터로 진행
  // monthly는 prev 데이터도 30일 → 더 긴 타임아웃 필요
  // skipPrev=true 또는 ENV로 강제 스킵 가능 (cron OOM 방지)
  let prevData = null;
  // 맞춤 기간: 동일 길이 직전 기간 (예: 5/1~5/12 12일 → 4/19~4/30)
  function getCustomPrevRange(dr) {
    const since = new Date(dr.since); const until = new Date(dr.until);
    const diffDays = Math.round((until - since) / 86400000) + 1; // inclusive
    const prevUntil = new Date(since); prevUntil.setDate(prevUntil.getDate() - 1);
    const prevSince = new Date(prevUntil); prevSince.setDate(prevSince.getDate() - (diffDays - 1));
    return { since: prevSince.toISOString().slice(0,10), until: prevUntil.toISOString().slice(0,10) };
  }
  const prevRange = (opts.skipPrev || process.env.SKIP_PREV_DATA === '1') ? null
    : (customRange && customRange.since && customRange.until ? getCustomPrevRange(customRange) : getPrevDateRange(type, dateRange));
  if (prevRange) {
    const prevTimeout = type === 'monthly' ? 180000 : 90000;
    try {
      const prevPromise = (async () => {
        const prev = await collectDetailData(client, prevRange);
        const pd = aggregateData(prev.rawAdDetail, prev.rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, prev.rawShopKwDetail, prev.rawShopConvDetail, kwQiMap, prev.rawQueryDetail);
        await calibrateWithStatsApi(pd, client, prevRange);
        return pd;
      })();
      prevData = await Promise.race([
        prevPromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('prev timeout')), prevTimeout)),
      ]);
    } catch (e) {
      console.log(`  ⚠️ 이전기간 스킵: ${e.message}`);
      prevData = null;
    }
  }

  return { data, prevData, period, dateRange, prevRange, isCustom: !!(customRange && customRange.since && customRange.until) };
}

/**
 * 미리보기용 HTML 생성 (이메일 발송 없이)
 */
async function generatePreview(account, type, customRange, opts) {
  const r = await collectReportData(account, type, customRange, opts);
  const { buildHtmlReport } = require('../email/sender');
  return buildHtmlReport({ type, period: r.period, accountName: account.name, data: r.data, prevData: r.prevData, dateRange: r.dateRange, prevRange: r.prevRange, isCustom: r.isCustom });
}

/**
 * Excel 버퍼 생성 (이메일 첨부와 동일한 파일을 다운로드용으로 반환)
 */
async function generateExcelBuffer(account, type, customRange, opts) {
  const r = await collectReportData(account, type, customRange, opts);
  const { buildExcelReport } = require('../email/excelReport');
  const reportConfig = db.parseReportConfig(account);
  return { buffer: await buildExcelReport({ type, period: r.period, accountName: account.name, data: r.data, prevData: r.prevData, dateRange: r.dateRange, prevRange: r.prevRange, isCustom: r.isCustom, reportConfig }), period: r.period };
}

/**
 * 리포트 데이터 캐시 — 성과개선 전략 페이지(증액/감액/발굴)가 짧은 시간 내
 * 같은 계정·기간을 반복 분석할 때 collectReportData(라이브 네이버 API)를 재사용.
 * 서버리스 warm 인스턴스 내에서만 유효(콜드 스타트 시 재수집). TTL 10분, 최대 3개.
 */
const _reportCache = new Map(); // key → { ts, value }
const REPORT_CACHE_TTL = 10 * 60 * 1000;
async function collectReportDataCached(account, type, customRange, opts) {
  // 자격증명을 키에 포함 → API 키/Customer ID 변경 시 캐시 무효화(stale 방지)
  const credHash = require('crypto').createHash('md5')
    .update(String(account.api_key || '') + '|' + String(account.secret_key || '') + '|' + String(account.customer_id || ''))
    .digest('hex').slice(0, 10);
  const key = `${account.id}:${type}:${credHash}:${customRange ? customRange.since + '~' + customRange.until : 'def'}:${opts && opts.skipPrev ? 'sp' : ''}`;
  const now = Date.now();
  const hit = _reportCache.get(key);
  if (hit && (now - hit.ts) < REPORT_CACHE_TTL) return hit.value;
  const value = await collectReportData(account, type, customRange, opts);
  _reportCache.set(key, { ts: now, value });
  // 메모리 보호: 오래된 항목 정리 (최대 3개 유지)
  if (_reportCache.size > 3) {
    const oldest = [..._reportCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) _reportCache.delete(oldest[0]);
  }
  return value;
}

// 등록 키워드 텍스트 목록 (디스커버리 중복 제외용)
async function getRegisteredKeywords(accountId) {
  try {
    const kws = await db.getMasterKeywords(accountId);
    return (kws || []).map(k => k.keyword).filter(Boolean);
  } catch (_) { return []; }
}

// 성과개선 전략용 롤링 기간 (라벨: 최근 30일/7일/어제)
function rollingRange(type) {
  const now = new Date();
  const fmt = d => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const end = new Date(now); end.setDate(end.getDate() - 1); // 어제(KST 기준 근사)
  if (type === 'daily') return { since: fmt(end), until: fmt(end), label: '어제' };
  const days = type === 'weekly' ? 7 : 30;
  const start = new Date(now); start.setDate(start.getDate() - days);
  return { since: fmt(start), until: fmt(end), label: `최근 ${days}일` };
}

/**
 * DB에 동기화된 통계(stat_daily_detail/stat_campaign_daily)로 리포트 data 객체를 조립.
 * 라이브 네이버 API 수집(30일=수백 콜, 타임아웃 위험) 대신 대시보드와 동일한
 * 즉시 응답 소스를 사용 → 성과개선 전략/원클릭 분석이 빠르고 안정적으로 동작.
 * (검색어별 byQuery는 DB 미보유 → 디스커버리는 키워드도구 기반으로 동작)
 */
async function buildDataFromDb(accountId, since, until) {
  const [summary, kwRows, campRows, agRows, devRows, hourly, trend] = await Promise.all([
    db.queryStatsSummary(accountId, since, until),
    db.queryStatsKeywords(accountId, since, until),
    db.queryStatsCampaigns(accountId, since, until),
    db.queryStatsAdgroups(accountId, since, until),
    db.queryStatsDevice(accountId, since, until),
    db.queryStatsHourly(accountId, since, until),
    db.queryStatsTrend(accountId, since, until),
  ]);

  const typeLabels = { 1: '파워링크', 2: '쇼핑검색', 3: '파워콘텐츠', 4: '브랜드검색', 6: '로컬' };
  const lbl = tp => typeLabels[Number(tp)] || `기타(${tp})`;
  const N = v => Number(v) || 0;
  const enrich = (o) => {
    o.cpc = o.clk > 0 ? Math.round(o.cost / o.clk) : 0;
    o.ctr = o.imp > 0 ? (o.clk / o.imp * 100) : 0;
    o.avgRank = o.avgRank || 0;
    o.roas = o.cost > 0 ? Math.round((o.purchaseAmt || 0) / o.cost * 100) : 0;
    o.cartCnt = o.cartCnt || 0; o.cartAmt = o.cartAmt || 0;
    return o;
  };
  const accum = (map, key, r, extra) => {
    if (!map[key]) map[key] = Object.assign({ imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 }, extra || {});
    map[key].imp += N(r.imp); map[key].clk += N(r.clk); map[key].cost += N(r.cost);
    map[key].purchaseCnt += N(r.purchaseCnt); map[key].purchaseAmt += N(r.purchaseAmt);
  };

  const total = enrich({ imp: N(summary.impCnt), clk: N(summary.clkCnt), cost: N(summary.salesAmt), purchaseCnt: N(summary.purchaseCnt), purchaseAmt: N(summary.purchaseAmt) });
  total.avgRank = N(summary.avgRnk);

  const byKeyword = {};
  for (const r of kwRows) {
    byKeyword['kw:' + r.keyword_id] = enrich({
      name: r.keyword, campaignName: r.campaignName, adgroupName: r.adgroupName,
      campaignType: lbl(r.campaignTp), qi: N(r.qiGrade), avgRank: 0,
      imp: N(r.imp), clk: N(r.clk), cost: N(r.cost), purchaseCnt: N(r.purchaseCnt), purchaseAmt: N(r.purchaseAmt),
    });
  }
  const byCampaign = {}, byCampaignType = {};
  for (const r of campRows) {
    const ct = lbl(r.campaignTp);
    byCampaign['c:' + r.campaign_id] = enrich({ name: r.campaignName, campaignType: ct, imp: N(r.imp), clk: N(r.clk), cost: N(r.cost), purchaseCnt: N(r.purchaseCnt), purchaseAmt: N(r.purchaseAmt) });
    accum(byCampaignType, ct, r);
  }
  Object.values(byCampaignType).forEach(enrich);
  const byAdgroup = {};
  for (const r of agRows) {
    byAdgroup['ag:' + r.adgroup_id] = enrich({ name: r.adgroupName, campaignName: r.campaignName, campaignType: lbl(r.campaignTp), imp: N(r.imp), clk: N(r.clk), cost: N(r.cost), purchaseCnt: N(r.purchaseCnt), purchaseAmt: N(r.purchaseAmt) });
  }
  const byDevice = {};
  for (const r of devRows) { const dv = (r.device === 'P' || r.device === 'PC') ? 'PC' : 'MO'; accum(byDevice, dv, r); }
  Object.values(byDevice).forEach(enrich);
  const byHour = {};
  for (const r of (hourly.byHour || [])) { byHour[String(r.hour).padStart(2, '0')] = enrich({ imp: N(r.imp), clk: N(r.clk), cost: N(r.cost), purchaseCnt: N(r.purchaseCnt), purchaseAmt: N(r.purchaseAmt) }); }
  const byDate = {};
  for (const r of trend) { byDate[r.date] = enrich({ imp: N(r.imp), clk: N(r.clk), cost: N(r.cost), purchaseCnt: N(r.purchaseCnt), purchaseAmt: N(r.purchaseAmt) }); }

  return { total, byCampaign, byCampaignType, byAdgroup, byKeyword, byQuery: {}, byDevice, byHour, byDate };
}

// 전략/원클릭용: DB 데이터 + 기간 라벨 (대시보드 미동기화 시 빈 데이터)
async function collectStrategyData(accountId, type) {
  const range = rollingRange(type);
  const data = await buildDataFromDb(accountId, range.since, range.until);
  const period = `${range.label} (${range.since.replace(/-/g, '.')}~${range.until.replace(/-/g, '.')})`;
  return { data, period, range };
}

/**
 * 원클릭 계정분석 제안 번들 생성
 * - 전체 리포트(시트 커스터마이징 적용) + 증액/감액/키워드발굴 제안 시트를 한 엑셀로 추출
 * - 화면 표시용 요약(summary)과 제안 목록(suggestions)도 함께 반환
 */
async function generateAnalysisBundle(account, type, customRange, opts) {
  // DB 동기화 통계 사용 (라이브 30일 수집 타임아웃 회피). 검색어별은 DB 미보유.
  const r = await collectStrategyData(account.id, type);
  const { analyzeAccount } = require('./suggestions');
  const { buildExcelReport } = require('../email/excelReport');

  // 키워드도구 보강 + 등록 키워드 목록(중복 제외용)
  const client = createApiClient({ apiKey: account.api_key, secretKey: account.secret_key, customerId: account.customer_id });
  const registeredKeywords = await getRegisteredKeywords(account.id);

  const suggestions = await analyzeAccount(r.data, client, { registeredKeywords });

  const reportConfig = db.parseReportConfig(account);
  const buffer = await buildExcelReport({
    type, period: r.period, accountName: account.name,
    data: r.data, prevData: null, dateRange: r.range, prevRange: null, isCustom: false,
    reportConfig, suggestions,
  });

  return { buffer, period: r.period, suggestions };
}

/**
 * 원클릭 '간략 분석' (통화용) — 증액·감액·발굴을 요약한 월간 제안 폼 데이터.
 * 엑셀을 만들지 않아 빠르고, 키워드도구는 생략(전환검색어 중심).
 */
async function generateAnalysisBrief(account, type) {
  const r = await collectStrategyData(account.id, type);
  const { analyzeAccount } = require('./suggestions');
  const client = createApiClient({ apiKey: account.api_key, secretKey: account.secret_key, customerId: account.customer_id });
  const registeredKeywords = await getRegisteredKeywords(account.id);
  const suggestions = await analyzeAccount(r.data, client, { registeredKeywords, skipTool: true });
  const t = r.data.total || {};
  return {
    period: r.period,
    accountName: account.name,
    kpi: { cost: t.cost || 0, purchaseAmt: t.purchaseAmt || 0, roas: t.roas || 0, clk: t.clk || 0 },
    summary: suggestions.summary,
    suggestions: {
      upsell: (suggestions.upsell || []).slice(0, 5),
      downsell: (suggestions.downsell || []).slice(0, 5),
      expansion: (suggestions.expansion || []).slice(0, 8),
    },
  };
}

/**
 * 성과개선 전략 단건 실행 (증액/감액/발굴) — 캐시된 데이터로 빠르게 분석
 * kind: 'upsell' | 'downsell' | 'discovery'
 * opts: 증액 {track}, 감액 {mode,targetPct,targetAmt}, 발굴 {channel,character}
 */
async function runStrategy(account, type, kind, opts = {}) {
  const r = await collectStrategyData(account.id, type);
  const { analyzeUpsell, analyzeDownsell, analyzeDiscovery } = require('./suggestions');
  if (kind === 'upsell') return { ...analyzeUpsell(r.data, opts), period: r.period };
  if (kind === 'downsell') return { ...analyzeDownsell(r.data, opts), period: r.period };
  if (kind === 'discovery') {
    const client = createApiClient({ apiKey: account.api_key, secretKey: account.secret_key, customerId: account.customer_id });
    const registeredKeywords = await getRegisteredKeywords(account.id);
    const d = await analyzeDiscovery(r.data, client, { ...opts, registeredKeywords });
    return { ...d, period: r.period };
  }
  throw new Error('알 수 없는 전략: ' + kind);
}

module.exports = { generateAndSend, generatePreview, generateExcelBuffer, generateAnalysisBundle, generateAnalysisBrief, runStrategy };
