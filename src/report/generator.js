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
async function collectDetailData(client, dateRange, opts = {}) {
  const light = !!opts.light; // light=AD_QUERY_DETAIL 생략(전략 라이브 폴백용: 메모리/속도)
  const skipShopping = opts.skipShopping === true; // 쇼핑 캠페인이 없는 계정: 쇼핑키워드 리포트 2종 생략 (API 호출 경량화, 결과는 어차피 빈 값)
  const dates = getDatesBetween(dateRange.since, dateRange.until);
  const rawAdDetail = [];
  const rawConvDetail = [];   // AD_CONVERSION (장기보존 ~8개월: 기기/키워드/광고그룹/일자 전환)
  const rawConvHourly = [];   // AD_CONVERSION_DETAIL (최근~45일: 시간대 전환 보강용)
  const rawShopKwDetail = [];
  const rawShopConvDetail = [];
  const rawQueryDetail = [];

  // AD_CONVERSION_DETAIL(시간대 전환) 보존기간(~45일) 밖 날짜는 호출 자체를 생략
  const hourConvCutoff = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);

  // 날짜별 N개씩 병렬 처리 (Naver API 부하 + 메모리 균형)
  const BATCH_SIZE = light ? 8 : 5;
  for (let i = 0; i < dates.length; i += BATCH_SIZE) {
    const batch = dates.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(
      batch.map(async (dt) => {
        // 시간대 전환(AD_CONVERSION_DETAIL)은 네이버 보존 ~45일 — 그 이전 날짜는 100% 실패(10004)라 호출 생략
        const hourConvOk = dt >= hourConvCutoff;
        const reqs = [
          client.createAndDownloadStatReport('AD_DETAIL', dt),
          client.createAndDownloadStatReport('AD_CONVERSION', dt),                  // 주 전환(장기보존 ~8개월)
          skipShopping ? Promise.resolve([]) : client.createAndDownloadStatReport('SHOPPINGKEYWORD_DETAIL', dt),
          skipShopping ? Promise.resolve([]) : client.createAndDownloadStatReport('SHOPPINGKEYWORD_CONVERSION_DETAIL', dt),
          hourConvOk ? client.createAndDownloadStatReport('AD_CONVERSION_DETAIL', dt) : Promise.resolve([]), // 시간대 전환(최근~45일)
        ];
        // AD_QUERY_DETAIL(검색어): 네이버 개편으로 폐기되어 400(11001) 전면 실패 → 호출 제거(byQuery는 빈 값 유지)
        const [adResult, convResult, shopResult, shopConvResult, convHourResult] = await Promise.allSettled(reqs);
        const queryResult = null;

        // AD_DETAIL: 전체 성과 데이터 (파워링크+쇼핑 모두 포함, 필터 없음)
        const adRows = adResult.status === 'fulfilled' ? adResult.value : [];
        if (adResult.status === 'rejected') console.log(`AD_DETAIL 실패 (${dt}):`, adResult.reason?.message);

        // AD_CONVERSION: 전체 전환 데이터 (장기보존, 시간대 컬럼 없음)
        const convRows = convResult.status === 'fulfilled' ? convResult.value : [];
        // AD_CONVERSION_DETAIL: 시간대 전환 보강 (최근만 성공, 과거기간은 실패→무시)
        const convHourRows = (convHourResult && convHourResult.status === 'fulfilled') ? convHourResult.value : [];

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

        // AD_QUERY_DETAIL: 검색어 텍스트 포함 (마스터 sync 의존 X). light 모드면 미수집.
        const queryRows = (queryResult && queryResult.status === 'fulfilled') ? queryResult.value : [];
        if (queryResult && queryResult.status === 'rejected') console.log(`AD_QUERY_DETAIL 실패 (${dt}):`, queryResult.reason?.message);

        return { dt, adRows, convRows, convHourRows, shopKwRows, shopConvRows, queryRows };
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        const { dt, adRows, convRows, convHourRows, shopKwRows, shopConvRows, queryRows } = result.value;
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
        rawConvHourly.push(...convHourRows.map(r => ({ date: dt, cols: r })));
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

  return { rawAdDetail, rawConvDetail, rawConvHourly, rawShopKwDetail, rawShopConvDetail, rawQueryDetail };
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
function aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap, rawQueryDetail, rawConvHourly) {
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

  // 구매 전환 판별 (영문 + 한국어 + 코드 대응)
  const isPurchaseType = (convType) => {
    const l = (convType || '').toLowerCase(); const r = (convType || '').trim();
    return l === 'purchase' || l === 'purchase_complete' || l === 'complete_purchase'
      || l === 'conversion' || l === 'conv' || l === '1' || r === '구매완료';
  };
  const isCartType = (convType) => {
    const l = (convType || '').toLowerCase(); const r = (convType || '').trim();
    return l === 'add_to_cart' || l === 'cart' || l === 'add_cart' || r === '장바구니 담기' || r === '장바구니';
  };
  // 전환 유형 한글 라벨 (실데이터는 영문 슬러그: purchase/add_to_cart/sign_up 실측 —
  //  네이버 문서상 숫자 코드(1~5)·한글 표기도 방어. 미지 유형은 원문 그대로 노출해 은폐 방지)
  const convTypeLabel = (convType) => {
    const l = (convType || '').toLowerCase().trim(); const r = (convType || '').trim();
    if (isPurchaseType(convType)) return '구매완료';
    if (isCartType(convType)) return '장바구니';
    if (l === 'sign_up' || l === 'signup' || l === '2' || r === '회원가입') return '회원가입';
    if (l === 'application' || l === 'reservation' || l === 'application_reservation' || l === '4' || r === '신청·예약' || r === '신청/예약') return '신청·예약';
    if (l === 'others' || l === 'other' || l === 'etc' || l === '5' || r === '기타') return '기타';
    return r || '기타';
  };
  // method(전환방법): AD_CONVERSION cols[9] / *_DETAIL cols[11] — 1=직접전환, 2=간접전환 (실측 검증)
  // 총 전환 = 전 유형 × (직접+간접) — 네이버 다차원보고서 '총 전환수' 정의(/stats ccnt와 일치 실측 확인)
  const addConv = (convMap, key, isPurchase, isCart, cnt, amt, method) => {
    if (!convMap[key]) convMap[key] = {
      purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0,
      convCnt: 0, convAmt: 0, convDirectCnt: 0, convDirectAmt: 0, convIndirectCnt: 0, convIndirectAmt: 0,
    };
    const c = convMap[key];
    if (isPurchase) { c.purchaseCnt += cnt; c.purchaseAmt += amt; }
    else if (isCart) { c.cartCnt += cnt; c.cartAmt += amt; }
    c.convCnt += cnt; c.convAmt += amt;
    if (String(method) === '2') { c.convIndirectCnt += cnt; c.convIndirectAmt += amt; }
    else { c.convDirectCnt += cnt; c.convDirectAmt += amt; } // 1=직접 (실측상 1/2만 존재, 미상 값은 직접 처리로 총합 보존)
  };

  // ── AD_CONVERSION (장기보존 ~8개월) 13컬럼: 0:date 2:camp 3:adgroup 4:keyword 8:device 10:convType 11:cnt 12:amt ──
  // AD_CONVERSION_DETAIL은 ~45일만 보존돼 과거기간 전환이 누락되므로 AD_CONVERSION으로 전환.
  // 시간대(hour) 컬럼이 없어 기기/키워드/광고그룹/캠페인/일자/전체 전환만 집계(시간대는 아래 별도 보강).
  const convMap = {}; // key → { purchaseCnt, purchaseAmt, cartCnt, cartAmt, convCnt, convAmt, convDirect*, convIndirect* }
  const convTypeSet = new Set();
  // '전환 유형' 차원 — AD_CONVERSION 단독 구축 (전 캠페인·8개월 보존·무중복. 쇼핑 루프와 합치면 이중집계)
  const byConvType = {};
  for (const { date: convDate, cols } of rawConvDetail) {
    if (cols.length < 13) continue;
    const campaignId = cols[2];
    const adgroupId = cols[3];
    const keywordId = cols[4];
    const device = cols[8] === 'P' ? 'PC' : 'MO';
    const method = cols[9]; // 1=직접전환, 2=간접전환
    const convType = cols[10];
    const cnt = parseInt(cols[11]) || 0;
    const amt = parseInt(cols[12]) || 0;
    const campType = getCampTypeLabel(campaignId);
    convTypeSet.add(convType);
    const isPurchase = isPurchaseType(convType);
    const isCart = isCartType(convType);
    const convKwKey = (keywordId && keywordId !== '-') ? `kw:${keywordId}` : `ag:${adgroupId}`;
    // Set으로 중복 제거 — keywordId 없는 행은 convKwKey가 ag: 와 겹쳐 광고그룹 전환이 이중 누적되던 버그 방지
    const keys = [...new Set([`camp:${campaignId}`, `ag:${adgroupId}`, `device:${device}`, convKwKey, `campType:${campType}`, `total`, `date:${convDate}`])];
    for (const key of keys) addConv(convMap, key, isPurchase, isCart, cnt, amt, method);
    // 전환 유형별 버킷 (라벨로 정규화해 purchase/'1'/'구매완료' 표기 혼재를 한 행으로 합침)
    const tLabel = convTypeLabel(convType);
    if (!byConvType[tLabel]) byConvType[tLabel] = {
      name: tLabel, imp: 0, clk: 0, cost: 0,
      convCnt: 0, convAmt: 0, convDirectCnt: 0, convDirectAmt: 0, convIndirectCnt: 0, convIndirectAmt: 0,
    };
    const bt = byConvType[tLabel];
    bt.convCnt += cnt; bt.convAmt += amt;
    if (String(method) === '2') { bt.convIndirectCnt += cnt; bt.convIndirectAmt += amt; }
    else { bt.convDirectCnt += cnt; bt.convDirectAmt += amt; }
  }

  // ── AD_CONVERSION_DETAIL (최근~45일) 15컬럼: 7:hour 12:convType 13:cnt 14:amt → 시간대(hour) 전환만 보강 ──
  // (과거기간은 이 리포트가 실패하여 시간대 전환은 비게 됨 — 네이버 OpenAPI 한계)
  for (const { cols } of (rawConvHourly || [])) {
    if (cols.length < 15) continue;
    const hour = parseInt(cols[7]) || 0;
    const convType = cols[12];
    const cnt = parseInt(cols[13]) || 0;
    const amt = parseInt(cols[14]) || 0;
    addConv(convMap, `hour:${hour}`, isPurchaseType(convType), isCartType(convType), cnt, amt, cols[11]);
  }
  // SHOPPINGKEYWORD_CONVERSION_DETAIL → 쇼핑 키워드별 전환만 convMap에 추가 (kw: 키만)
  // (캠페인/그룹/일자/total의 쇼핑 전환은 AD_CONVERSION이 이미 포함 — 다른 키에 넣으면 이중집계)
  for (const { cols } of (rawShopConvDetail || [])) {
    if (cols.length < 15) continue;
    const keywordId = cols[4];
    if (!keywordId || keywordId === '-' || keywordId === '') continue;
    const convType = cols[12];
    const cnt = parseInt(cols[13]) || 0;
    const amt = parseInt(cols[14]) || 0;
    addConv(convMap, `kw:${keywordId}`, isPurchaseType(convType), isCartType(convType), cnt, amt, cols[11]);
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

    // 키워드별 (파워링크 등 비쇼핑만 — 쇼핑검색 키워드 성과는 SHOPPINGKEYWORD_DETAIL 텍스트 행 전담.
    //  쇼핑 캠페인의 AD_DETAIL 행을 넣으면 ID 미해결·SHOPPINGKEYWORD와 이중집계 경로가 생김)
    if (keywordId && keywordId !== '0' && keywordId !== '' && keywordId !== '-' && !isShopping(campaignId)) {
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
    const conv = convMap[convKey] || {};
    obj.cpc = obj.clk > 0 ? Math.round(obj.cost / obj.clk) : 0;
    obj.ctr = obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0;
    obj.avgRank = obj.rankCount > 0 ? (obj.rankSum / obj.rankCount) : 0;
    obj.purchaseCnt = conv.purchaseCnt || 0;
    obj.purchaseAmt = conv.purchaseAmt || 0;
    obj.cartCnt = conv.cartCnt || 0;
    obj.cartAmt = conv.cartAmt || 0;
    obj.roas = obj.cost > 0 ? Math.round(obj.purchaseAmt / obj.cost * 100) : 0;
    // 총/직접/간접 전환 (전 유형 합 — 다차원보고서 '총 전환' 정의)
    obj.convCnt = conv.convCnt || 0;
    obj.convAmt = conv.convAmt || 0;
    obj.convDirectCnt = conv.convDirectCnt || 0;
    obj.convDirectAmt = conv.convDirectAmt || 0;
    obj.convIndirectCnt = conv.convIndirectCnt || 0;
    obj.convIndirectAmt = conv.convIndirectAmt || 0;
    obj.convRate = obj.clk > 0 ? (obj.convCnt / obj.clk * 100) : 0;
    obj.costPerConv = obj.convCnt > 0 ? Math.round(obj.cost / obj.convCnt) : 0;
    obj.roasTotal = obj.cost > 0 ? Math.round(obj.convAmt / obj.cost * 100) : 0;
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
        && (d.purchaseCnt || 0) === 0 && (d.cartCnt || 0) === 0 && (d.convCnt || 0) === 0) {
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
    d.convCnt = 0; d.convAmt = 0; d.convDirectCnt = 0; d.convDirectAmt = 0; d.convIndirectCnt = 0; d.convIndirectAmt = 0;
    d.convRate = 0; d.costPerConv = 0; d.roasTotal = 0;
  });
  if (Object.keys(byQuery).length > 0) {
    console.log(`  🔍 AD_QUERY_DETAIL 검색어별 ${Object.keys(byQuery).length}개 집계`);
  }

  return { total, byCampaign, byCampaignType, byAdgroup, byKeyword, byDevice, byHour, byDate, byQuery, byConvType };
}

// ─── /stats 보정·비교기간 공통 헬퍼 ─────────────────────────────────
const TYPE_LABELS = {
  '1': '파워링크', 'WEB_SITE': '파워링크',
  '2': '쇼핑검색', 'SHOPPING': '쇼핑검색',
  '3': '파워콘텐츠', 'POWER_CONTENTS': '파워콘텐츠',
  '4': '브랜드검색', 'BRAND': '브랜드검색', 'BRAND_SEARCH': '브랜드검색',
  '6': '로컬', 'LOCAL_SMB': '로컬',
};
function enrichStatsObj(o) {
  o.cpc = o.clk > 0 ? Math.round(o.cost / o.clk) : 0;
  o.ctr = o.imp > 0 ? (o.clk / o.imp * 100) : 0;
  o.avgRank = o.rankCount > 0 ? (o.rankSum / o.rankCount) : (o.avgRank || 0);
  o.cartCnt = o.cartCnt || 0;
  o.cartAmt = o.cartAmt || 0;
  o.purchaseCnt = o.purchaseCnt || 0;
  o.purchaseAmt = o.purchaseAmt || 0;
  o.roas = o.cost > 0 ? Math.round((o.purchaseAmt || 0) / o.cost * 100) : 0;
  // 총/직접/간접 전환 — 기존 값 보존(|| 0), 파생만 재계산
  o.convCnt = o.convCnt || 0;
  o.convAmt = o.convAmt || 0;
  o.convDirectCnt = o.convDirectCnt || 0;
  o.convDirectAmt = o.convDirectAmt || 0;
  o.convIndirectCnt = o.convIndirectCnt || 0;
  o.convIndirectAmt = o.convIndirectAmt || 0;
  o.convRate = o.clk > 0 ? (o.convCnt / o.clk * 100) : 0;
  o.costPerConv = o.convCnt > 0 ? Math.round(o.cost / o.convCnt) : 0;
  o.roasTotal = o.cost > 0 ? Math.round(o.convAmt / o.cost * 100) : 0;
  return o;
}

/**
 * /stats(대시보드 동일 소스) 1회 수집으로 총합·캠페인·캠페인유형·일자·광고그룹을 정확 보정.
 * (기존 calibrateWithStatsApi + calibrateDimensionsWithStats 통합 — 캠페인별 /stats
 *  중복 호출 제거로 리포트당 캠페인 수만큼의 API 콜 절감)
 * - total/byCampaign/byCampaignType/byDate/byAdgroup: /stats 값으로 교체(다차원보고서 정합)
 * - byDevice/byHour: 분포는 AD_DETAIL 유지, 합계만 /stats 총합에 비례 보정
 */
async function calibrateAllWithStats(data, client, dateRange, campTypeMap) {
  try {
    const dims = await client.getDashboardDimensions({ startDate: dateRange.since, endDate: dateRange.until });
    const t = dims.total || {};
    if ((t.imp || 0) === 0 && (t.clk || 0) === 0 && (t.cost || 0) === 0) {
      console.log('  ⚠️ /stats 보정: 데이터 없음 (AD_DETAIL 집계 유지)');
      return data;
    }
    console.log(`  🔄 /stats 보정: TSV cost=${data.total.cost} → 실제 cost=${t.cost}, 구매완료=${t.purchaseCnt}건/${t.purchaseAmt}원`);

    // 1) 총합 교체
    data.total.imp = t.imp || 0;
    data.total.clk = t.clk || 0;
    data.total.cost = t.cost || 0;
    data.total.purchaseCnt = t.purchaseCnt || 0;
    data.total.purchaseAmt = t.purchaseAmt || 0;
    data.total.convCnt = t.convCnt || 0;
    data.total.convAmt = t.convAmt || 0;
    if ((t.rankCount || 0) > 0) data.total.avgRank = t.rankSum / t.rankCount;
    data.total.cpc = data.total.clk > 0 ? Math.round(data.total.cost / data.total.clk) : 0;
    data.total.ctr = data.total.imp > 0 ? (data.total.clk / data.total.imp * 100) : 0;
    data.total.roas = data.total.cost > 0 ? Math.round((data.total.purchaseAmt || 0) / data.total.cost * 100) : 0;
    // 총전환 파생 재계산 (직접/간접은 /stats에 없어 TSV 값 유지 — 실측상 합계 일치)
    data.total.convRate = data.total.clk > 0 ? (data.total.convCnt / data.total.clk * 100) : 0;
    data.total.costPerConv = data.total.convCnt > 0 ? Math.round(data.total.cost / data.total.convCnt) : 0;
    data.total.roasTotal = data.total.cost > 0 ? Math.round(data.total.convAmt / data.total.cost * 100) : 0;

    // 2) 캠페인별 교체 (유형은 기존 유지, 이름 미해결 시 /stats 이름으로 해석)
    //    AD_DETAIL에 행이 없던 캠페인(수집 실패·노출0 비용발생 등)도 /stats에 있으면 신규 추가 — 합계 불일치 방지
    for (const [cid, cs] of Object.entries(dims.byCampaign || {})) {
      let camp = data.byCampaign[cid];
      if (!camp) {
        if ((cs.cost || 0) === 0 && (cs.imp || 0) === 0 && (cs.clk || 0) === 0) continue;
        camp = data.byCampaign[cid] = {
          name: cs.name || cid,
          campaignType: TYPE_LABELS[String((campTypeMap || {})[cid] || '1')] || '기타',
          imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0, cartCnt: 0, cartAmt: 0,
          convDirectCnt: 0, convDirectAmt: 0, convIndirectCnt: 0, convIndirectAmt: 0,
        };
      }
      camp.imp = cs.imp; camp.clk = cs.clk; camp.cost = cs.cost;
      camp.purchaseCnt = cs.purchaseCnt; camp.purchaseAmt = cs.purchaseAmt;
      camp.convCnt = cs.convCnt || 0; camp.convAmt = cs.convAmt || 0;
      if ((cs.rankCount || 0) > 0) { camp.avgRank = cs.rankSum / cs.rankCount; camp.rankSum = camp.avgRank; camp.rankCount = 1; }
      camp.cpc = camp.clk > 0 ? Math.round(camp.cost / camp.clk) : 0;
      camp.ctr = camp.imp > 0 ? (camp.clk / camp.imp * 100) : 0;
      camp.roas = camp.cost > 0 ? Math.round((camp.purchaseAmt || 0) / camp.cost * 100) : 0;
      camp.convRate = camp.clk > 0 ? (camp.convCnt / camp.clk * 100) : 0;
      camp.costPerConv = camp.convCnt > 0 ? Math.round(camp.cost / camp.convCnt) : 0;
      camp.roasTotal = camp.cost > 0 ? Math.round(camp.convAmt / camp.cost * 100) : 0;
      if (camp.name === cid && cs.name) camp.name = cs.name; // ID 미해결 캠페인명 해석
    }

    // 3) 캠페인유형별 재집계 (보정된 byCampaign 기반)
    const newByCampType = {};
    for (const campId of Object.keys(data.byCampaign)) {
      const camp = data.byCampaign[campId];
      const ct = camp.campaignType || '기타';
      if (!newByCampType[ct]) newByCampType[ct] = {
        imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0,
        purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0,
        convCnt: 0, convAmt: 0, convDirectCnt: 0, convDirectAmt: 0, convIndirectCnt: 0, convIndirectAmt: 0,
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
      newByCampType[ct].convCnt += camp.convCnt || 0;
      newByCampType[ct].convAmt += camp.convAmt || 0;
      newByCampType[ct].convDirectCnt += camp.convDirectCnt || 0;
      newByCampType[ct].convDirectAmt += camp.convDirectAmt || 0;
      newByCampType[ct].convIndirectCnt += camp.convIndirectCnt || 0;
      newByCampType[ct].convIndirectAmt += camp.convIndirectAmt || 0;
    }
    Object.values(newByCampType).forEach(enrichStatsObj);
    data.byCampaignType = newByCampType;

    // 4) 일자별 교체 (전환·비용 정확) — 직접/간접 분리는 /stats에 없어 TSV(AD_CONVERSION) 값 병합
    if (dims.byDate && Object.keys(dims.byDate).length) {
      const oldByDate = data.byDate || {};
      for (const k of Object.keys(dims.byDate)) {
        const o = dims.byDate[k], old = oldByDate[k];
        if (old) {
          o.convDirectCnt = old.convDirectCnt || 0; o.convDirectAmt = old.convDirectAmt || 0;
          o.convIndirectCnt = old.convIndirectCnt || 0; o.convIndirectAmt = old.convIndirectAmt || 0;
        }
        enrichStatsObj(o);
      }
      data.byDate = dims.byDate;
    }

    // 5) 광고그룹별 교체 (이름은 API 신선값, 캠페인유형은 보정된 byCampaign에서) — 직접/간접은 TSV 값 병합
    if (dims.byAdgroup && Object.keys(dims.byAdgroup).length) {
      const oldByAdgroup = data.byAdgroup || {};
      const out = {};
      for (const [agId, o] of Object.entries(dims.byAdgroup)) {
        const camp = data.byCampaign && data.byCampaign[o.campaignId];
        o.name = o.adgroupName || agId;
        o.campaignName = o.campaignName || (camp && camp.name) || '';
        o.campaignType = (camp && camp.campaignType) || '파워링크';
        const old = oldByAdgroup[agId];
        if (old) {
          o.convDirectCnt = old.convDirectCnt || 0; o.convDirectAmt = old.convDirectAmt || 0;
          o.convIndirectCnt = old.convIndirectCnt || 0; o.convIndirectAmt = old.convIndirectAmt || 0;
        }
        enrichStatsObj(o);
        out[agId] = o; // aggregateData와 동일하게 raw adgroupId 키 사용
      }
      data.byAdgroup = out;
    }

    // 6) 기기별·시간대별: 비용 분포는 AD_DETAIL, 총합은 /stats에 정합되도록 비례 보정
    //    (AD_DETAIL 비용이 대시보드 대비 ~9% 적은 알려진 차이 → 분포는 유지하며 총합을 일치).
    //    전환(purchaseCnt/Amt)은 AD_CONVERSION에서 이미 정확 → 그대로 두고 cost만 스케일.
    const scaleDimToTotal = (dim) => {
      const entries = Object.values(dim || {});
      if (!entries.length) return;
      const sum = (f) => entries.reduce((a, o) => a + (o[f] || 0), 0);
      const sImp = sum('imp'), sClk = sum('clk'), sCost = sum('cost');
      const rImp = sImp > 0 ? data.total.imp / sImp : 1;
      const rClk = sClk > 0 ? data.total.clk / sClk : 1;
      const rCost = sCost > 0 ? data.total.cost / sCost : 1;
      for (const o of entries) {
        o.imp = Math.round((o.imp || 0) * rImp);
        o.clk = Math.round((o.clk || 0) * rClk);
        o.cost = Math.round((o.cost || 0) * rCost);
        enrichStatsObj(o);
      }
    };
    scaleDimToTotal(data.byDevice);
    scaleDimToTotal(data.byHour);

    console.log(`  ✅ /stats 보정 완료: cost=${data.total.cost}, 구매완료=${data.total.purchaseCnt}건/${data.total.purchaseAmt}원, 일자 ${Object.keys(data.byDate || {}).length}일 · 광고그룹 ${Object.keys(data.byAdgroup || {}).length}개`);
    return data;
  } catch (e) {
    console.log(`  ⚠️ /stats 보정 실패(AD_DETAIL 집계 유지):`, e.message);
    return data;
  }
}

/**
 * 비교기간(prev) 데이터를 /stats만으로 구성 — 상세 리포트 수집 없이 수십 배 빠름.
 * 리포트의 비교 시트는 total·byCampaignType·byAdgroup만 사용하므로(엑셀·HTML 공통 확인)
 * 상세리포트 4종 × 일수 job 대신 /stats 한 번으로 충분하다.
 */
async function collectPrevViaStats(client, prevRange, campTypeMap, opts) {
  // totalOnly: 일간 리포트처럼 비교시트가 없어 prev.total만 쓰는 경우 광고그룹 스윕 생략
  const totalOnly = !!(opts && opts.totalOnly);
  const dims = await client.getDashboardDimensions({ startDate: prevRange.since, endDate: prevRange.until, dateOnly: totalOnly });
  const labelOf = (cid) => TYPE_LABELS[String((campTypeMap || {})[cid] || '1')] || '기타';

  const byCampaign = {};
  const byCampaignType = {};
  for (const [cid, cs] of Object.entries(dims.byCampaign || {})) {
    const camp = enrichStatsObj(Object.assign({}, cs, { name: cs.name || cid, campaignType: labelOf(cid) }));
    byCampaign[cid] = camp;
    const ct = camp.campaignType;
    if (!byCampaignType[ct]) byCampaignType[ct] = { imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0, purchaseCnt: 0, purchaseAmt: 0, cartCnt: 0, cartAmt: 0 };
    const t = byCampaignType[ct];
    t.imp += camp.imp; t.clk += camp.clk; t.cost += camp.cost;
    t.purchaseCnt += camp.purchaseCnt; t.purchaseAmt += camp.purchaseAmt;
    if (camp.avgRank > 0) { t.rankSum += camp.avgRank; t.rankCount += 1; }
  }
  Object.values(byCampaignType).forEach(enrichStatsObj);

  const byAdgroup = {};
  for (const [agId, o] of Object.entries(dims.byAdgroup || {})) {
    byAdgroup[agId] = enrichStatsObj(Object.assign({}, o, {
      name: o.adgroupName || agId,
      campaignName: o.campaignName || '',
      campaignType: labelOf(o.campaignId),
    }));
  }

  const byDate = {};
  for (const [d, o] of Object.entries(dims.byDate || {})) byDate[d] = enrichStatsObj(Object.assign({}, o));

  const total = enrichStatsObj(Object.assign({ imp: 0, clk: 0, cost: 0, rankSum: 0, rankCount: 0, purchaseCnt: 0, purchaseAmt: 0 }, dims.total || {}));
  return { total, byCampaign, byCampaignType, byAdgroup, byDate, byKeyword: {}, byDevice: {}, byHour: {}, byQuery: {} };
}

/**
 * 미해결 이름(ID 그대로 노출) 재해석 — 'ID 미인식 제외' 발생 방지.
 * DB 마스터가 오래되어(예: 키워드 100개 이상 있으나 최신 키워드 누락) 이름이 안 풀린
 * 항목이 있으면 마스터 리포트를 재조회해 이름을 채우고, DB에도 백그라운드로 반영해
 * 대시보드 탭까지 함께 치유한다.
 */
const UNRESOLVED_NAME_RE = /^(grp|cmp|adg|nkw|ncc|nccc|nad|nccad|bnc|cnv)[-_]/i;
async function resolveUnresolvedNames(data, client, maps, account) {
  const { campNameMap, agNameMap, kwNameMap } = maps;
  const kwUnres = Object.keys(data.byKeyword || {}).filter(k => UNRESOLVED_NAME_RE.test((data.byKeyword[k] || {}).name || ''));
  const agUnres = Object.keys(data.byAdgroup || {}).filter(k => UNRESOLVED_NAME_RE.test((data.byAdgroup[k] || {}).name || ''));
  const campUnres = Object.keys(data.byCampaign || {}).filter(k => UNRESOLVED_NAME_RE.test((data.byCampaign[k] || {}).name || ''));
  if (!kwUnres.length && !agUnres.length && !campUnres.length) return;
  console.log(`  🔎 미해결 이름 감지: 키워드 ${kwUnres.length} · 그룹 ${agUnres.length} · 캠페인 ${campUnres.length} → 마스터 재조회`);
  try {
    if (kwUnres.length) {
      const rows = await client.syncMaster('Keyword');
      for (const r of rows) { if (r.length >= 4) kwNameMap[r[2]] = r[3]; }
      if (account && account.id) db.upsertMasterKeywords(account.id, rows).catch(() => {});
    }
    if (agUnres.length) {
      const rows = await client.syncMaster('Adgroup');
      for (const r of rows) { if (r.length >= 4) agNameMap[r[1]] = r[3]; }
      if (account && account.id) db.upsertMasterAdgroups(account.id, rows).catch(() => {});
    }
    if (campUnres.length) {
      const rows = await client.syncMaster('Campaign');
      for (const r of rows) { if (r.length >= 3) campNameMap[r[1]] = r[2]; }
      if (account && account.id) db.upsertMasterCampaigns(account.id, rows).catch(() => {});
    }
  } catch (e) {
    console.log('  ⚠️ 마스터 재조회 실패:', e.message);
  }
  // 재매핑
  let fixed = 0;
  for (const k of kwUnres) {
    const d = data.byKeyword[k];
    const kid = k.startsWith('kw:') ? k.slice(3) : k;
    if (kwNameMap[kid]) { d.name = kwNameMap[kid]; fixed++; }
  }
  for (const agId of agUnres) {
    if (agNameMap[agId]) { data.byAdgroup[agId].name = agNameMap[agId]; fixed++; }
  }
  for (const cid of campUnres) {
    if (campNameMap[cid]) { data.byCampaign[cid].name = campNameMap[cid]; fixed++; }
  }
  const remain = kwUnres.length + agUnres.length + campUnres.length - fixed;
  console.log(`  ✅ 이름 재해석: ${fixed}개 해결${remain > 0 ? `, ${remain}개 미해결(삭제된 항목 추정)` : ''}`);
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
    // 재조회 조건: 맵이 비었거나(신규/미저장) DB 마스터가 7일 이상 오래된 경우(이름 변경 반영).
    // 저장된 마스터가 있으면 재사용 — 매 발송마다 마스터 4종을 재수집하던 것을 경량화.
    // 이름 미해석 ID가 발견되면 아래 resolveUnresolvedNames가 재조회하므로 신규 캠페인/키워드도 안전.
    const initialKwCount = Object.keys(kwNameMap).length;
    let masterStale = false;
    try {
      const r = await db.pool.query('SELECT MAX(synced_at) AS ts FROM master_keywords WHERE account_id = $1', [account.id]);
      const ts = r.rows[0]?.ts ? new Date(r.rows[0].ts).getTime() : 0;
      masterStale = !ts || (Date.now() - ts > 7 * 24 * 3600 * 1000);
    } catch (_) { masterStale = true; }
    const shouldFetchMaster = Object.keys(campNameMap).length === 0
      || initialKwCount === 0
      || masterStale;
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

        // DB에 저장 (다음번을 위해 — Qi도 저장해야 재사용 시 품질지수 열이 비지 않음)
        try {
          if (campRows.length > 0) await db.upsertMasterCampaigns(account.id, campRows);
          if (agRows.length > 0) await db.upsertMasterAdgroups(account.id, agRows);
          if (kwRows.length > 0) await db.upsertMasterKeywords(account.id, kwRows);
          if (qiRows.length > 0) await db.upsertMasterQi(account.id, qiRows);
        } catch (_) {}
      } catch (e) {
        console.log('  ⚠️ API 마스터 리포트 매핑 실패:', e.message);
      }
    }

    // 2. AD_DETAIL + AD_CONVERSION_DETAIL + SHOPPINGKEYWORD 수집
    // 쇼핑 캠페인(유형 2)이 하나도 없으면 쇼핑키워드 리포트 2종 생략 — 유형 맵이 비어있으면 안전하게 전체 수집
    const campTps = Object.values(campTypeMap);
    const skipShopping = campTps.length > 0 && !campTps.some(tp => parseInt(tp) === 2);
    if (skipShopping) console.log('  ⚡ 쇼핑 캠페인 없음 → 쇼핑키워드 리포트 수집 생략');
    const { rawAdDetail, rawConvDetail, rawConvHourly, rawShopKwDetail, rawShopConvDetail, rawQueryDetail } = await collectDetailData(client, dateRange, { skipShopping });

    // 3. 다차원 집계
    const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap, rawQueryDetail, rawConvHourly);

    // 3-1. 미해결 이름(ID 노출) 감지 시 마스터 재조회로 재해석 ('ID 미인식 제외' 방지)
    await resolveUnresolvedNames(data, client, { campNameMap, agNameMap, kwNameMap }, account);
    // 3-2. /stats 1회 수집으로 총합·캠페인·유형·일자·광고그룹 정확 보정 (다차원보고서 정합)
    await calibrateAllWithStats(data, client, dateRange, campTypeMap);

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
    // 비교기간: opts.comparePeriod로 직접 지정 가능, 없으면 동일길이 직전기간 자동
    const prevRange = (opts.skipPrev || process.env.SKIP_PREV_DATA === '1') ? null
      : ((opts.comparePeriod && opts.comparePeriod.since && opts.comparePeriod.until) ? opts.comparePeriod
        : (customRange && customRange.since && customRange.until ? getCustomPrevRange2(customRange) : getPrevDateRange(type, dateRange)));
    if (prevRange) {
      const prevLabel = { daily: '전일', weekly: '전주', monthly: '전전월' }[type];
      console.log(`  📊 ${prevLabel} 데이터 수집: ${prevRange.since} ~ ${prevRange.until}`);
      try {
        // 비교시트는 총합·캠페인유형·광고그룹만 사용 → 상세리포트 수집 없이 /stats만 조회 (수십 배 가속)
        // 일간(비맞춤)은 비교시트가 없어 total만 필요 → 광고그룹 스윕까지 생략
        const totalOnly = type === 'daily' && !(customRange && customRange.since);
        prevData = await collectPrevViaStats(client, prevRange, campTypeMap, { totalOnly });
        console.log(`  ✅ ${prevLabel} 데이터 완료 (/stats · 캠페인 ${Object.keys(prevData.byCampaign).length}개${totalOnly ? ' · 경량' : ''})`);
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

    // 6. 발송 후 리포트 job 정리 (계정당 100 한도 누적 방지 — 특히 매일 도는 일간)
    try {
      const n = await client.cleanupReportJobs();
      if (n > 0) console.log(`  🧹 발송 후 리포트 job ${n}개 정리`);
    } catch (_) {}

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

  // DB에 캠페인이 없거나 '키워드 매핑이 부족'하면 API 마스터로 폴백.
  // ※ 캠페인/그룹은 DB에 있어도 키워드가 0이면 파워링크 키워드가 ID로 남아 전부 '미인식'
  //   처리되므로, 키워드 개수 기준도 함께 확인한다. (한촌설렁탕: 캠57/그룹308/키워드0 → 미인식)
  // ※ Keyword 마스터는 대용량 계정에서 수 분 걸릴 수 있어 타임아웃 180초로 상향(기존 15초는 부족).
  const kwCountDb = Object.keys(kwNameMap).length;
  if (Object.keys(campNameMap).length === 0 || kwCountDb < 100) {
    try {
      const masterTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('타임아웃')), 180000));
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
      console.log(`  📋 API 마스터 보완: 캠페인 ${campRows.length} · 그룹 ${agRows.length} · 키워드 ${kwRows.length} (DB키워드 ${kwCountDb}개 → 보완)`);
    } catch (e) { console.log('  ⚠️ API 마스터 폴백 실패:', e.message); }
  }

  // 전체 타임아웃: monthly 600s / weekly 300s / daily 180s
  const overallTimeout = type === 'monthly' ? 600000 : (type === 'weekly' ? 300000 : 180000);
  const timeoutPromise = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`리포트 생성 시간 초과(${overallTimeout / 1000}s). 데이터가 너무 많거나 API 응답이 느립니다.`)), overallTimeout)
  );

  const collectMain = (async () => {
    const { rawAdDetail, rawConvDetail, rawConvHourly, rawShopKwDetail, rawShopConvDetail, rawQueryDetail } = await collectDetailData(client, dateRange);
    const data = aggregateData(rawAdDetail, rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, rawShopKwDetail, rawShopConvDetail, kwQiMap, rawQueryDetail, rawConvHourly);
    await resolveUnresolvedNames(data, client, { campNameMap, agNameMap, kwNameMap }, account);
    await calibrateAllWithStats(data, client, dateRange, campTypeMap);
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
  // 비교기간: opts.comparePeriod로 직접 지정 가능(예: 5.1~5.14), 없으면 동일길이 직전기간 자동
  const prevRange = (opts.skipPrev || process.env.SKIP_PREV_DATA === '1') ? null
    : ((opts.comparePeriod && opts.comparePeriod.since && opts.comparePeriod.until) ? opts.comparePeriod
      : (customRange && customRange.since && customRange.until ? getCustomPrevRange(customRange) : getPrevDateRange(type, dateRange)));
  if (prevRange) {
    const prevTimeout = type === 'monthly' ? 180000 : 90000;
    try {
      // 비교시트는 총합·캠페인유형·광고그룹만 사용 → 상세리포트 수집 없이 /stats만 조회 (수십 배 가속)
      const prevPromise = collectPrevViaStats(client, prevRange, campTypeMap, { totalOnly: type === 'daily' && !(customRange && customRange.since) });
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

// 전략 라이브 경량 수집 (DB 미동기화 계정용)
// AD_QUERY_DETAIL/Stats 보정을 생략해 메모리·시간을 크게 줄이고, 총합은 /stats 1콜로 정확화.
// 집계 결과를 누적 병합 (원본 raw는 청크마다 버림 → 메모리 고정)
function mergeAgg(acc, part) {
  const DIMS = ['byCampaign', 'byCampaignType', 'byAdgroup', 'byKeyword', 'byDevice', 'byHour', 'byDate', 'byQuery', 'byConvType'];
  const RAW = ['imp', 'clk', 'cost', 'rankSum', 'rankCount', 'purchaseCnt', 'purchaseAmt', 'cartCnt', 'cartAmt',
    'convCnt', 'convAmt', 'convDirectCnt', 'convDirectAmt', 'convIndirectCnt', 'convIndirectAmt'];
  const reEnrich = (o) => {
    o.cpc = o.clk > 0 ? Math.round(o.cost / o.clk) : 0;
    o.ctr = o.imp > 0 ? (o.clk / o.imp * 100) : 0;
    o.avgRank = o.rankCount > 0 ? (o.rankSum / o.rankCount) : 0;
    o.roas = o.cost > 0 ? Math.round((o.purchaseAmt || 0) / o.cost * 100) : 0;
    o.convRate = o.clk > 0 ? ((o.convCnt || 0) / o.clk * 100) : 0;
    o.costPerConv = (o.convCnt || 0) > 0 ? Math.round(o.cost / o.convCnt) : 0;
    o.roasTotal = o.cost > 0 ? Math.round((o.convAmt || 0) / o.cost * 100) : 0;
  };
  if (!acc) acc = { total: {}, byCampaign: {}, byCampaignType: {}, byAdgroup: {}, byKeyword: {}, byDevice: {}, byHour: {}, byDate: {}, byQuery: {}, byConvType: {} };
  RAW.forEach(f => acc.total[f] = (acc.total[f] || 0) + (part.total[f] || 0));
  reEnrich(acc.total);
  for (const dim of DIMS) {
    const src = part[dim] || {};
    for (const k of Object.keys(src)) {
      const bd = src[k];
      if (!acc[dim][k]) { acc[dim][k] = Object.assign({}, bd); }
      else { RAW.forEach(f => acc[dim][k][f] = (acc[dim][k][f] || 0) + (bd[f] || 0)); reEnrich(acc[dim][k]); }
    }
  }
  return acc;
}

async function collectStrategyLive(account, range) {
  const client = createApiClient({ apiKey: account.api_key, secretKey: account.secret_key, customerId: account.customer_id });
  // 이름 맵 (DB 마스터 우선)
  const campNameMap = {}, campTypeMap = {}, agNameMap = {}, kwNameMap = {}, kwQiMap = {};
  try {
    const m = await db.buildKeywordMaps(account.id);
    for (const [id, info] of Object.entries(m.campMap || {})) { campNameMap[id] = info.name; campTypeMap[id] = info.tp || 1; }
    for (const [id, info] of Object.entries(m.agMap || {})) { agNameMap[id] = info.name; }
    for (const [id, info] of Object.entries(m.kwMap || {})) { kwNameMap[id] = info.keyword; if (info.qi) kwQiMap[id] = info.qi; }
  } catch (_) {}

  // 이름 보강: 최신 마스터(그룹·캠페인) 병합으로 ID로 남은 항목 최소화.
  // 그룹/캠페인은 가벼워 항상 시도, 키워드는 타임아웃(40s) 가드로 시도.
  try {
    const [campRows, agRows] = await Promise.all([
      client.syncMaster('Campaign').catch(() => []),
      client.syncMaster('Adgroup').catch(() => []),
    ]);
    for (const r of campRows) { if (r.length >= 3) { campNameMap[r[1]] = r[2]; if (r[3] != null) campTypeMap[r[1]] = parseInt(r[3]) || campTypeMap[r[1]] || 1; } }
    for (const r of agRows) { if (r.length >= 4) agNameMap[r[1]] = r[3]; }
  } catch (_) {}
  try {
    const kwRows = await Promise.race([
      client.syncMaster('Keyword').catch(() => []),
      new Promise(res => setTimeout(() => res([]), 40000)),
    ]);
    for (const r of (kwRows || [])) { if (r.length >= 4) kwNameMap[r[2]] = r[3]; }
  } catch (_) {}

  // 스트리밍 집계: 5일씩 수집→집계→병합, 원본은 즉시 버려 메모리 고정 (30일 OOM 방지)
  const dates = getDatesBetween(range.since, range.until);
  const CHUNK = 5;
  let data = null;
  for (let i = 0; i < dates.length; i += CHUNK) {
    const sub = { since: dates[i], until: dates[Math.min(i + CHUNK - 1, dates.length - 1)] };
    const raw = await collectDetailData(client, sub, { light: true });
    const part = aggregateData(raw.rawAdDetail, raw.rawConvDetail, campNameMap, agNameMap, campTypeMap, kwNameMap, raw.rawShopKwDetail, raw.rawShopConvDetail, kwQiMap, [], raw.rawConvHourly);
    data = mergeAgg(data, part);
    // raw, part는 다음 반복에서 GC 대상
  }
  if (!data) data = mergeAgg(null, { total: {}, byCampaign: {}, byCampaignType: {}, byAdgroup: {}, byKeyword: {}, byDevice: {}, byHour: {}, byDate: {}, byQuery: {} });

  // 총합은 Stats API(1콜)로 정확화 (네이버 대시보드 일치)
  try {
    const s = await client.getStats({ startDate: range.since, endDate: range.until });
    if (s) {
      const t = data.total;
      t.imp = s.impCnt || t.imp; t.clk = s.clkCnt || t.clk; t.cost = s.salesAmt || t.cost;
      if (typeof s.purchaseCcnt === 'number') t.purchaseCnt = s.purchaseCcnt;
      if (typeof s.purchaseConvAmt === 'number') t.purchaseAmt = s.purchaseConvAmt;
      t.ctr = t.imp > 0 ? (t.clk / t.imp * 100) : 0;
      t.cpc = t.clk > 0 ? Math.round(t.cost / t.clk) : 0;
      t.roas = t.cost > 0 ? Math.round((t.purchaseAmt || 0) / t.cost * 100) : 0;
    }
  } catch (_) {}
  return data;
}

// 전략/원클릭용: DB 동기화 데이터 우선 + 기간 라벨.
// 분석은 키워드·그룹 단위 데이터가 필요하므로, DB에 그게 없으면(요약만 있고
// 상세(stat_daily_detail) 미동기화여도) 라이브 경량 수집으로 폴백(타임아웃 가드).
async function collectStrategyData(account, type) {
  const range = rollingRange(type);
  let data = await buildDataFromDb(account.id, range.since, range.until);
  let source = 'db';
  // 분석이 실제 쓰는 키워드/그룹 데이터가 비어있으면 폴백 (요약 total만으론 분석 불가)
  const noDetail = Object.keys(data.byKeyword || {}).length === 0 && Object.keys(data.byAdgroup || {}).length === 0;
  if (noDetail && account.api_key) {
    source = 'live';
    // 라이브 수집은 Vercel 800s 한도 안쪽에서 자체 타임아웃 → 함수 크래시 대신 명확한 에러
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('전략 데이터 수집 시간이 초과되었습니다. 더 짧은 기간(어제/최근 7일)으로 시도해주세요.')), 240000));
    data = await Promise.race([collectStrategyLive(account, range), guard]);
  }
  const period = `${range.label} (${range.since.replace(/-/g, '.')}~${range.until.replace(/-/g, '.')})`;
  return { data, period, range, source };
}

/**
 * 원클릭 계정분석 제안 번들 생성
 * - 전체 리포트(시트 커스터마이징 적용) + 증액/감액/키워드발굴 제안 시트를 한 엑셀로 추출
 * - 화면 표시용 요약(summary)과 제안 목록(suggestions)도 함께 반환
 */
async function generateAnalysisBundle(account, type, customRange, opts) {
  // DB 동기화 통계 사용 (라이브 30일 수집 타임아웃 회피). 검색어별은 DB 미보유.
  const r = await collectStrategyData(account, type);
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
  const r = await collectStrategyData(account, type);
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
    performance: suggestions.performance,
    suggestions: {
      upsell: (suggestions.upsell || []).slice(0, 5),
      downsell: (suggestions.downsell || []).slice(0, 5),
    },
  };
}

/**
 * 성과개선 전략 단건 실행 (증액/감액/발굴) — 캐시된 데이터로 빠르게 분석
 * kind: 'upsell' | 'downsell' | 'discovery'
 * opts: 증액 {track}, 감액 {mode,targetPct,targetAmt}, 발굴 {channel,character}
 */
async function runStrategy(account, type, kind, opts = {}) {
  const r = await collectStrategyData(account, type);
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

// 증액 다차원 엑셀 (그룹별/키워드별/기기별) 스트리밍용 버퍼
async function generateUpsellExcel(account, type, opts = {}) {
  const r = await collectStrategyData(account, type);
  const { analyzeUpsell } = require('./suggestions');
  const { buildUpsellExcel } = require('../email/strategyExcel');
  const up = analyzeUpsell(r.data, opts);
  const buffer = await buildUpsellExcel({
    accountName: account.name, period: r.period, track: up.summary.track, channels: up.summary.channels,
    groups: up.groups, keywords: up.keywords, devices: up.devices,
  });
  return { buffer, period: r.period };
}

// 감액 엑셀 (키워드/검색어별 + 기기별) 스트리밍용 버퍼
async function generateDownsellExcel(account, type, opts = {}) {
  const r = await collectStrategyData(account, type);
  const { analyzeDownsell } = require('./suggestions');
  const { buildDownsellExcel } = require('../email/strategyExcel');
  const d = analyzeDownsell(r.data, opts);
  const buffer = await buildDownsellExcel({
    accountName: account.name, period: r.period, summary: d.summary, items: d.items, devices: d.devices,
  });
  return { buffer, period: r.period };
}

module.exports = { generateAndSend, generatePreview, generateExcelBuffer, generateAnalysisBundle, generateAnalysisBrief, runStrategy, generateUpsellExcel, generateDownsellExcel, collectReportData };
