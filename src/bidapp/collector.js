// ─── 이고진 입찰관리: 데이터 수집 (네이버 검색광고 API) ─────────────
// 1) 쇼핑검색 소재 동기화 (캠페인 → 광고그룹 → 소재, 현재 입찰가 포함)
// 2) 소재별 주차 성과 수집 (/stats 일별 행 → 주차 집계, 간접전환 포함 convAmt/ccnt)
const { createApiClient } = require('../api/naverApi');
const bidDb = require('./db');
const { last4Weeks } = require('./logic');

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
// 쇼핑검색(campaignTp 2/'SHOPPING') 캠페인의 소재만 대상 — 파워링크(WEB_SITE) 등 다른 유형은 제외.
// (소재별 ROAS 설정·입찰 조정 모두 쇼핑검색 소재에만 반영)
async function syncMaterials(account, creds) {
  const client = makeClient(creds, account.customer_id);
  const campaigns = await client.getCampaigns();
  const isShopping = (c) => {
    const tp = c.campaignTp;
    if (tp === 2 || tp === '2') return true;
    if (typeof tp === 'string' && tp.toUpperCase().includes('SHOPPING')) return true;
    // campaignTp 미제공 응답 폴백: 캠페인명 기준 (파워링크 유형이 명시된 경우는 제외)
    if (tp == null && c.name && c.name.includes('쇼핑')) return true;
    return false;
  };
  const targets = (campaigns || []).filter(c => (c.status === 'ELIGIBLE' || !c.status) && isShopping(c));

  // 광고그룹 조회 (그룹 기본입찰가 → useGroupBidAmt 소재의 현재가)
  const agRes = await mapLimit(targets, 5, c => client.getAdGroups(c.nccCampaignId).then(ags => ({ camp: c, ags: ags || [] })));
  const allAgs = [];
  for (const r of agRes) {
    if (r.status !== 'fulfilled') continue;
    for (const ag of r.value.ags) {
      if (ag.status && ag.status !== 'ELIGIBLE') continue;
      allAgs.push({ camp: r.value.camp, ag });
    }
  }

  // 소재 조회
  const adRes = await mapLimit(allAgs, 5, ({ camp, ag }) => client.getAds(ag.nccAdgroupId).then(ads => ({ camp, ag, ads: ads || [] })));
  let count = 0;
  const seenAdIds = new Set();
  for (const r of adRes) {
    if (r.status !== 'fulfilled') continue;
    const { camp, ag, ads } = r.value;
    for (const ad of ads) {
      if (ad.status && ad.status !== 'ELIGIBLE') continue;
      const adAttr = ad.adAttr || {};
      const useGroupBid = adAttr.useGroupBidAmt !== false; // 쇼핑 소재 기본: 그룹입찰가 사용
      const bid = (!useGroupBid && adAttr.bidAmt) ? adAttr.bidAmt : (ag.adgroupAttrJson?.bidAmt || ag.bidAmt || adAttr.bidAmt || 0);
      const name = ad.ad?.headline || ad.ad?.subject || adAttr.headline
        || ad.referenceData?.productName || ad.ad?.productName || ad.nccAdId;
      await bidDb.upsertMaterial(account.id, {
        nccAdId: ad.nccAdId,
        nccAdgroupId: ag.nccAdgroupId,
        name: String(name).slice(0, 200),
        campaignName: camp.name || '',
        adgroupName: ag.name || '',
        currentBid: parseInt(bid) || 0,
        useGroupBid,
        registeredAt: ad.regTm || ad.regTime || '',
      });
      seenAdIds.add(ad.nccAdId);
      count++;
    }
  }

  // API에서 사라진(삭제/중지) 소재는 비활성 처리
  const existing = await bidDb.getMaterials(account.id);
  for (const m of existing) {
    if (!seenAdIds.has(m.ncc_ad_id) && m.enabled) {
      await bidDb.updateMaterialMeta(m.id, account.id, { enabled: 0 });
    }
  }
  return { synced: count };
}

// ─── 주차별 성과 수집 ──────────────────────────────────────────────
// 소재당 /stats 1회 (4주 범위 일별 행) → 주차별 집계 저장
async function collectWeeklyStats(account, creds, { weeks } = {}) {
  const client = makeClient(creds, account.customer_id);
  const wks = weeks || last4Weeks();
  const since = wks[wks.length - 1].start;
  const until = wks[0].end;
  const materials = await bidDb.getMaterials(account.id, { enabledOnly: true });
  let ok = 0, fail = 0;

  await mapLimit(materials, 5, async (m) => {
    try {
      const result = await client.getEntityStats(m.ncc_ad_id, { since, until });
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
        b.revenue += d.convAmt || 0;   // 전환매출 (간접전환 포함)
        b.convCnt += d.ccnt || 0;      // 전환수 (간접전환 포함)
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

// ─── 일간 모니터용: 전일 소재별 성과 ────────────────────────────────
async function collectDailyStats(account, creds, dateStr) {
  const client = makeClient(creds, account.customer_id);
  const materials = await bidDb.getMaterials(account.id, { enabledOnly: true });
  const out = [];
  await mapLimit(materials, 5, async (m) => {
    try {
      const result = await client.getEntityStats(m.ncc_ad_id, { since: dateStr, until: dateStr });
      let cost = 0, revenue = 0;
      for (const d of (result?.data || [])) {
        cost += d.salesAmt || 0;
        revenue += d.convAmt || 0;
      }
      out.push({ material: m, cost, revenue });
    } catch (e) { /* 소재 단위 실패 무시 */ }
  });
  return out;
}

// ─── 기준매출용: 전월(달력 기준) 소재별 매출 합계 ───────────────────
// hasData=false → 해당 기간 API 행이 전무하거나 전 지표 0 (신규 소재 → 기준매출 null)
async function collectMonthlyRevenue(account, creds, since, until) {
  const client = makeClient(creds, account.customer_id);
  const materials = await bidDb.getMaterials(account.id, { enabledOnly: true });
  const out = [];
  await mapLimit(materials, 5, async (m) => {
    try {
      const result = await client.getEntityStats(m.ncc_ad_id, { since, until });
      let revenue = 0, hasData = false;
      for (const d of (result?.data || [])) {
        revenue += d.convAmt || 0;
        if ((d.impCnt || 0) + (d.clkCnt || 0) + (d.salesAmt || 0) + (d.convAmt || 0) > 0) hasData = true;
      }
      out.push({ material: m, revenue, hasData });
    } catch (e) {
      console.log(`  ⚠️ 기준매출 수집 실패 (${m.ncc_ad_id}):`, e.message);
    }
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

module.exports = { syncMaterials, collectWeeklyStats, collectDailyStats, collectMonthlyRevenue, fetchLiveBid, applyBid, mapLimit };
