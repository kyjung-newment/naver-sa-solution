// ─── 이고진 입찰관리: 데이터 수집 (네이버 검색광고 API) ─────────────
// 1) 쇼핑검색 소재 동기화 (캠페인 → 광고그룹 → 소재, 현재 입찰가 포함)
// 2) 소재별 주차 성과 수집 (/stats 일별 행 → 주차 집계, 구매전환매출 purchaseConvAmt/purchaseCcnt 기준)
const { createApiClient } = require('../api/naverApi');
const bidDb = require('./db');
const { last4Weeks, parseExcludedCampaigns, isExcludedCampaign } = require('./logic');

// 동시성 제한 (429 회피)
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const res = await Promise.allSettled(items.slice(i, i + limit).map(fn));
    out.push(...res);
  }
  return out;
}

function makeClient(creds, customerId) {
  return createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId });
}

// ─── 쇼핑검색 소재 동기화 ──────────────────────────────────────────
// 쇼핑검색(campaignTp SHOPPING/2) 캠페인의 '쇼핑몰 상품형' 소재만 대상 — 엄격 매칭:
// 유형 필드가 없거나 다른 값이면 무조건 제외 (파워링크·브랜드검색·파워콘텐츠·플레이스 등).
// 설정의 제외 캠페인(excluded_campaigns) 목록에 걸리는 캠페인도 수집·조정 대상에서 제외.
async function syncMaterials(account, creds) {
  const client = makeClient(creds, account.customer_id);
  const settings = await bidDb.getSettings(account.id);
  const excluded = parseExcludedCampaigns(settings.excluded_campaigns);
  const campaigns = await client.getCampaigns();

  // 유형 진단: 실제 API 응답의 유형 값 분포를 감사로그에 남긴다 (필터 검증용)
  const diag = { campaignTp: {}, adgroupType: {}, adType: {} };
  const bump = (o, k) => { const key = String(k ?? '(없음)'); o[key] = (o[key] || 0) + 1; };

  // 캠페인: 쇼핑검색만. 유형 값 표기가 환경마다 달라(2/'SHOPPING'/'shopping' 등) 폭넓게 매칭하되,
  // 파워링크(WEB_SITE)·브랜드검색·파워콘텐츠·플레이스는 명시적으로 제외한다.
  const NON_SHOPPING = ['WEB_SITE', 'WEBSITE', 'POWER_CONTENTS', 'BRAND_SEARCH', 'PLACE'];
  const isShopping = (c) => {
    const raw = c.campaignTp ?? c.campaignType;
    bump(diag.campaignTp, raw);
    if (raw === 2 || raw === '2') return true;
    const t = String(raw ?? '').toUpperCase();
    if (NON_SHOPPING.some(x => t.includes(x))) return false;
    if (t.includes('SHOP') || String(raw ?? '').includes('쇼핑')) return true;
    return false;
  };
  const targets = (campaigns || []).filter(c =>
    (c.status === 'ELIGIBLE' || !c.status)
    && isShopping(c)
    && !isExcludedCampaign(c.name, excluded));

  // 광고그룹: 쇼핑 브랜드형(키워드 운용)·카탈로그형만 명시 제외 (상품형은 통과 — 차단목록 방식)
  const isProductGroup = (ag) => {
    const raw = ag.adgroupType ?? ag.adGroupType ?? ag.type;
    bump(diag.adgroupType, raw);
    const t = String(raw ?? '').toUpperCase();
    if (!t) return true;
    return !(t.includes('BRAND') || t.includes('CATALOG') || t.includes('TEMPLATE'));
  };
  const agRes = await mapLimit(targets, 5, c => client.getAdGroups(c.nccCampaignId).then(ags => ({ camp: c, ags: ags || [] })));
  const allAgs = [];
  for (const r of agRes) {
    if (r.status !== 'fulfilled') continue;
    for (const ag of r.value.ags) {
      if (ag.status && ag.status !== 'ELIGIBLE') continue;
      if (!isProductGroup(ag)) continue;
      allAgs.push({ camp: r.value.camp, ag });
    }
  }

  // 소재: 브랜드/카탈로그 소재만 명시 제외 (상품 소재는 통과)
  const isProductAd = (ad) => {
    const raw = ad.type ?? ad.adTp;
    bump(diag.adType, raw);
    const t = String(raw ?? '').toUpperCase();
    if (!t) return true;
    return !(t.includes('BRAND') || t.includes('CATALOG'));
  };
  // 기존 저장 입찰가 맵 (외부 변경 감지용 — API 수신값과 비교)
  const prevBids = {};
  for (const m of await bidDb.getMaterials(account.id)) prevBids[m.ncc_ad_id] = { id: m.id, bid: parseInt(m.current_bid) || 0 };
  const latestWeek = last4Weeks()[0].start; // 입찰가 스냅샷 귀속 주차 (최신 완료 주)

  const adRes = await mapLimit(allAgs, 5, ({ camp, ag }) => client.getAds(ag.nccAdgroupId).then(ads => ({ camp, ag, ads: ads || [] })));
  let count = 0, bidChanges = 0;
  const seenAdIds = new Set();
  for (const r of adRes) {
    if (r.status !== 'fulfilled') continue;
    const { camp, ag, ads } = r.value;
    for (const ad of ads) {
      if (ad.status && ad.status !== 'ELIGIBLE') continue;
      if (!isProductAd(ad)) continue;
      const adAttr = ad.adAttr || {};
      const useGroupBid = adAttr.useGroupBidAmt !== false; // 쇼핑 소재 기본: 그룹입찰가 사용
      const bid = (!useGroupBid && adAttr.bidAmt) ? adAttr.bidAmt : (ag.adgroupAttrJson?.bidAmt || ag.bidAmt || adAttr.bidAmt || 0);
      const name = ad.ad?.headline || ad.ad?.subject || adAttr.headline
        || ad.referenceData?.productName || ad.ad?.productName || ad.nccAdId;
      const newBid = parseInt(bid) || 0;
      const materialId = await bidDb.upsertMaterial(account.id, {
        nccAdId: ad.nccAdId,
        nccAdgroupId: ag.nccAdgroupId,
        name: String(name).slice(0, 200),
        campaignName: camp.name || '',
        adgroupName: ag.name || '',
        currentBid: newBid,
        useGroupBid,
        registeredAt: ad.regTm || ad.regTime || '',
      });
      // 주간 입찰가 스냅샷: 이전 저장값과 다르면(솔루션 외 광고시스템 변경 포함) 변경 전 값을 함께 기록
      const prev = prevBids[ad.nccAdId];
      const changed = prev && prev.bid > 0 && newBid > 0 && prev.bid !== newBid;
      if (changed) bidChanges++;
      try {
        await bidDb.setWeekBid(materialId, latestWeek, { weekBid: newBid, changedFrom: changed ? prev.bid : null });
      } catch (e) { /* 스냅샷 실패는 동기화를 막지 않음 */ }
      seenAdIds.add(ad.nccAdId);
      count++;
    }
  }

  // API에서 사라진(삭제/중지/유형 제외) 소재는 '자동 비활성' 처리 — 수동 제외(enabled)와 분리.
  // 안전장치: 이번 동기화가 0건이면(필터/API 이상 가능성) 기존 소재를 건드리지 않는다.
  if (count > 0) {
    const existing = await bidDb.getMaterials(account.id);
    for (const m of existing) {
      if (!seenAdIds.has(m.ncc_ad_id) && !m.auto_disabled) {
        await bidDb.setMaterialAutoDisabled(m.id, true);
      }
    }
  } else {
    console.log(`  ⚠️ [${account.name}] 동기화 결과 0건 — 기존 소재 자동 비활성 처리 건너뜀`);
  }
  await bidDb.audit(account.id, 'sync', '소재 동기화 진단', {
    campaigns: (campaigns || []).length, shoppingTargets: targets.length,
    productGroups: allAgs.length, synced: count, bidChanges, types: diag,
  });
  return { synced: count, bidChanges, diag };
}

// ─── 주차별 성과 수집 ──────────────────────────────────────────────
// 소재당 /stats 1회 (4주 범위 일별 행) → 주차별 집계 저장
// 매출 지표 = 구매전환매출(purchaseConvAmt) — 총전환매출(convAmt, 장바구니 등 포함)이 아닌
// 구매 완료 기준. 모든 조정 판정(블렌딩ROAS·기준매출·일간 트리거)이 이 값 기준으로 계산된다.
const STAT_FIELDS = ['clkCnt', 'impCnt', 'salesAmt', 'cpc', 'avgRnk', 'ccnt', 'convAmt', 'purchaseCcnt', 'purchaseConvAmt'];

async function collectWeeklyStats(account, creds, { weeks } = {}) {
  const client = makeClient(creds, account.customer_id);
  const wks = weeks || last4Weeks();
  const since = wks[wks.length - 1].start;
  const until = wks[0].end;
  const materials = await bidDb.getMaterials(account.id, { enabledOnly: true });
  let ok = 0, fail = 0;

  await mapLimit(materials, 5, async (m) => {
    try {
      const result = await client.getEntityStats(m.ncc_ad_id, { since, until, fields: STAT_FIELDS });
      // 주차별 버킷 초기화
      const buckets = {};
      for (const w of wks) buckets[w.start] = { imp: 0, clk: 0, cost: 0, revenue: 0, convCnt: 0, rankSum: 0, rankW: 0 };
      for (const d of (result?.data || [])) {
        const date = d.dateStart || d.date;
        if (!date) continue;
        // 해당 일자가 속한 주차 찾기
        const w = wks.find(w => date >= w.start && date <= w.end);
        if (!w) continue;
        const b = buckets[w.start];
        b.imp += d.impCnt || 0;
        b.clk += d.clkCnt || 0;
        b.cost += d.salesAmt || 0;
        b.revenue += d.purchaseConvAmt || 0;  // 구매전환매출
        b.convCnt += d.purchaseCcnt || 0;     // 구매전환수
        if (d.avgRnk > 0) { const wgt = d.impCnt || 1; b.rankSum += d.avgRnk * wgt; b.rankW += wgt; }
      }
      for (const w of wks) {
        const b = buckets[w.start];
        await bidDb.upsertWeeklyStat(m.id, w.start, {
          imp: b.imp, clk: b.clk, cost: b.cost, revenue: b.revenue, convCnt: b.convCnt,
          avgRank: b.rankW > 0 ? b.rankSum / b.rankW : 0,
          avgCpc: b.clk > 0 ? Math.round(b.cost / b.clk) : 0,
        });
      }
      ok++;
    } catch (e) {
      fail++;
      console.log(`  ⚠️ 소재 성과 수집 실패 (${m.ncc_ad_id}):`, e.message);
    }
  });
  return { materials: materials.length, ok, fail, weeks: wks };
}

// ─── 일간 모니터용: 전일 소재별 성과 (구매전환매출 기준) ─────────────
async function collectDailyStats(account, creds, dateStr) {
  const client = makeClient(creds, account.customer_id);
  const materials = await bidDb.getMaterials(account.id, { enabledOnly: true });
  const out = [];
  await mapLimit(materials, 5, async (m) => {
    try {
      const result = await client.getEntityStats(m.ncc_ad_id, { since: dateStr, until: dateStr, fields: STAT_FIELDS });
      let cost = 0, revenue = 0;
      for (const d of (result?.data || [])) {
        cost += d.salesAmt || 0;
        revenue += d.purchaseConvAmt || 0;
      }
      out.push({ material: m, cost, revenue });
    } catch (e) { /* 소재 단위 실패 무시 */ }
  });
  return out;
}

// ─── 적용 전 현재 입찰가 재조회 (안전장치) ──────────────────────────
async function fetchLiveBid(account, creds, nccAdId) {
  const client = makeClient(creds, account.customer_id);
  const ad = await client.getAdDetail(nccAdId);
  const adAttr = ad?.adAttr || {};
  if (adAttr.useGroupBidAmt === false && adAttr.bidAmt) return { bid: adAttr.bidAmt, useGroupBid: false };
  // 그룹입찰가 사용 소재
  try {
    const ag = await client.getAdGroupDetail(ad.nccAdgroupId);
    return { bid: ag?.bidAmt || adAttr.bidAmt || 0, useGroupBid: true };
  } catch (e) {
    return { bid: adAttr.bidAmt || 0, useGroupBid: adAttr.useGroupBidAmt !== false };
  }
}

// ─── 입찰가 적용 (쇼핑검색 소재 adAttr.bidAmt PUT) ──────────────────
async function applyBid(account, creds, nccAdId, bidAmt) {
  const client = makeClient(creds, account.customer_id);
  return client.updateAdBid(nccAdId, bidAmt);
}

module.exports = { syncMaterials, collectWeeklyStats, collectDailyStats, fetchLiveBid, applyBid, mapLimit };
