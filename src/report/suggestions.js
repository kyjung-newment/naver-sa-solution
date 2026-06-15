/**
 * 원클릭 계정분석 제안 엔진
 *
 * 리포트 집계 데이터(data)를 입력받아 3가지 성과 개선 제안을 생성한다.
 *  - 업셀링(증액):   성과 우수(고ROAS·고CTR)인데 노출/순위 여력이 있는 타겟 → 입찰·예산 증액
 *  - 다운셀링(감액): 비용 발생 대비 전환 없음/저효율 → 입찰 하향·OFF
 *  - 키워드 발굴:    ①전환 발생 검색어(미등록) ②키워드도구 연관 키워드 → 신규 키워드 등록
 *
 * 모든 임계값은 '계정 평균' 대비 상대값으로 계산하여 업종/규모와 무관하게 동작한다.
 */

// ─── 임계값 ─────────────────────────────────────────────────────────
const MIN_CLICKS_UPSELL = 10;    // 증액 판단 최소 클릭 (신호 확보)
const MIN_CLICKS_DOWNSELL = 15;  // 감액 판단 최소 클릭 (전환 0이 우연이 아님)
const MIN_CLICKS_EXPAND = 3;     // 검색어 발굴 최소 클릭
const GOOD_ROAS_MULT = 1.3;      // 계정 평균 ROAS의 1.3배 이상이면 우수
const GOOD_ROAS_FLOOR = 300;     // 최소 ROAS 300%
const HIGH_CTR_MULT = 1.2;       // 계정 평균 CTR의 1.2배 이상이면 우수
const LOW_ROAS_MULT = 0.5;       // 계정 평균 ROAS의 절반 미만이면 비효율
const RANK_ROOM = 1.5;           // 평균순위 1.5위보다 낮으면(=숫자 큼) 상향 여력
const MAX_PER_CATEGORY = 40;     // 카테고리별 최대 제안 수
const MIN_MONTHLY_VOL = 50;      // 키워드도구 연관키워드 최소 월 검색량
const UNRESOLVED_RE = /^(nkw|ncc|nad|nccad)[-_]/i;

const fmt = n => Number(n || 0).toLocaleString('ko-KR');
const won = n => `₩${fmt(n)}`;
const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();

// 키워드도구 검색량 파싱 ("< 10" → 5 등)
function parseVol(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[,\s]/g, '');
  if (s.startsWith('<')) return 5;
  const n = parseInt(s);
  return isNaN(n) ? 0 : n;
}

/**
 * 동기 분석: 데이터만으로 업셀/다운셀/검색어발굴(소스1) 생성
 */
function analyzeSync(data, opts = {}) {
  const total = data.total || {};
  const avgRoas = total.roas || 0;
  const avgCtr = total.ctr || 0;
  const avgCpc = total.cpc || 0;

  const byKeyword = data.byKeyword || {};
  const byQuery = data.byQuery || {};

  // ── 등록 키워드 집합 (발굴 시 중복 제외용) ──
  const registeredSet = new Set();
  if (Array.isArray(opts.registeredKeywords)) {
    for (const k of opts.registeredKeywords) registeredSet.add(norm(k));
  }
  for (const d of Object.values(byKeyword)) {
    if (d && d.name && !UNRESOLVED_RE.test(d.name)) registeredSet.add(norm(d.name));
  }

  const goodRoasBar = Math.max(GOOD_ROAS_FLOOR, avgRoas * GOOD_ROAS_MULT);

  // ── 업셀링 (증액) ──
  const upsell = [];
  for (const d of Object.values(byKeyword)) {
    if (!d || (d.cost || 0) <= 0 || (d.clk || 0) < MIN_CLICKS_UPSELL) continue;
    if ((d.purchaseCnt || 0) < 1) continue; // 검증된 전환 키워드만 증액
    const efficient = (d.roas || 0) >= goodRoasBar;
    const engaging = avgCtr > 0 && (d.ctr || 0) >= avgCtr * HIGH_CTR_MULT && (d.roas || 0) >= avgRoas;
    if (!efficient && !engaging) continue;
    // 노출/순위 상향 여력: 평균순위가 1위가 아니거나(=여력) 순위 데이터 없음
    const room = (d.avgRank || 0) === 0 || (d.avgRank || 0) > RANK_ROOM;
    const reasonBits = [`ROAS ${fmt(d.roas)}%`];
    if (avgRoas > 0) reasonBits.push(`(계정평균 ${fmt(avgRoas)}%)`);
    reasonBits.push(`CTR ${(d.ctr || 0).toFixed(2)}%`);
    if (d.avgRank > 0) reasonBits.push(`평균순위 ${d.avgRank.toFixed(1)}위`);
    upsell.push({
      scope: '키워드', name: d.name,
      campaignName: d.campaignName || '', adgroupName: d.adgroupName || '', campaignType: d.campaignType || '',
      imp: d.imp || 0, clk: d.clk || 0, cost: d.cost || 0, ctr: d.ctr || 0, cpc: d.cpc || 0,
      avgRank: d.avgRank || 0, roas: d.roas || 0, purchaseCnt: d.purchaseCnt || 0, purchaseAmt: d.purchaseAmt || 0,
      action: room ? '입찰가 상향 → 노출·전환 확대' : '예산/입찰 증액 → 전환 볼륨 확대',
      reason: `${reasonBits.join(' · ')} — 효율 우수, 확대 여력 있음`,
      score: (d.roas || 0) * (d.cost || 0),
    });
  }
  upsell.sort((a, b) => b.score - a.score);

  // ── 다운셀링 (감액) ──
  const downsell = [];
  for (const d of Object.values(byKeyword)) {
    if (!d || (d.cost || 0) <= 0 || (d.clk || 0) < MIN_CLICKS_DOWNSELL) continue;
    const wasteful = (d.purchaseCnt || 0) === 0;
    const lowEff = (d.roas || 0) > 0 && avgRoas > 0 && (d.roas || 0) < avgRoas * LOW_ROAS_MULT && (d.cost || 0) >= avgCpc * 10;
    if (!wasteful && !lowEff) continue;
    let action, reason;
    if (wasteful) {
      action = '입찰가 하향 또는 OFF';
      reason = `비용 ${won(d.cost)} · 클릭 ${fmt(d.clk)}회 · 전환 0 — 효율 없음`;
    } else {
      action = '입찰가 하향 → 예산 효율화';
      reason = `ROAS ${fmt(d.roas)}% (계정평균 ${fmt(avgRoas)}%의 절반 미만) · 비용 ${won(d.cost)} — 저효율`;
    }
    downsell.push({
      scope: '키워드', name: d.name,
      campaignName: d.campaignName || '', adgroupName: d.adgroupName || '', campaignType: d.campaignType || '',
      imp: d.imp || 0, clk: d.clk || 0, cost: d.cost || 0, ctr: d.ctr || 0, cpc: d.cpc || 0,
      avgRank: d.avgRank || 0, roas: d.roas || 0, purchaseCnt: d.purchaseCnt || 0, purchaseAmt: d.purchaseAmt || 0,
      action, reason,
      score: d.cost || 0,
    });
  }
  downsell.sort((a, b) => b.score - a.score);

  // ── 키워드 발굴 소스1: 전환 발생 미등록 검색어 ──
  const expansion = [];
  const seenExp = new Set();
  for (const d of Object.values(byQuery)) {
    if (!d || !d.name) continue;
    const key = norm(d.name);
    if (!key || registeredSet.has(key) || seenExp.has(key)) continue;
    if ((d.clk || 0) < MIN_CLICKS_EXPAND) continue;
    const converts = (d.purchaseCnt || 0) >= 1;
    const efficient = avgRoas > 0 && (d.roas || 0) >= avgRoas;
    if (!converts && !efficient) continue;
    seenExp.add(key);
    expansion.push({
      keyword: d.name, source: '전환검색어',
      campaignName: d.campaignName || '', adgroupName: d.adgroupName || '', campaignType: d.campaignType || '',
      currentClk: d.clk || 0, currentCost: d.cost || 0, currentPurchase: d.purchaseCnt || 0, currentRoas: d.roas || 0,
      monthlyPc: null, monthlyMobile: null, monthlyTotal: null, compIdx: '',
      action: '정식 키워드로 등록',
      reason: converts
        ? `광고 노출 중 전환 발생 (클릭 ${fmt(d.clk)} · 구매 ${fmt(d.purchaseCnt)}) — 미등록 검색어`
        : `광고 노출 중 ROAS ${fmt(d.roas)}% (계정평균 이상) — 미등록 검색어`,
      score: (d.purchaseAmt || 0) * 10 + (d.clk || 0),
    });
  }
  expansion.sort((a, b) => b.score - a.score);

  const meta = {
    avgRoas, avgCtr, avgCpc,
    totalCost: total.cost || 0, totalClk: total.clk || 0, totalPurchaseAmt: total.purchaseAmt || 0,
    keywordCount: Object.keys(byKeyword).length, queryCount: Object.keys(byQuery).length,
  };

  return { upsell, downsell, expansion, registeredSet, meta };
}

/**
 * 비동기 분석: analyzeSync + 키워드도구 연관키워드(소스2) 보강
 * @param {object} data  리포트 집계 데이터
 * @param {object} client naverApi 클라이언트 (getRelatedKeywords). 없으면 소스2 생략
 */
async function analyzeAccount(data, client, opts = {}) {
  const base = analyzeSync(data, opts);
  const { upsell, downsell, expansion, registeredSet, meta } = base;

  // 키워드도구 보강: 전환 우수 등록 키워드를 seed로 연관 키워드 발굴
  if (client && typeof client.getRelatedKeywords === 'function') {
    try {
      const byKeyword = data.byKeyword || {};
      // seed: 구매매출 상위 등록 키워드(텍스트) 최대 10개
      const seeds = Object.values(byKeyword)
        .filter(d => d && d.name && !UNRESOLVED_RE.test(d.name) && (d.purchaseCnt || 0) >= 1)
        .sort((a, b) => (b.purchaseAmt || 0) - (a.purchaseAmt || 0))
        .map(d => d.name)
        .slice(0, 10);

      const expandedNames = new Set([...registeredSet, ...expansion.map(e => norm(e.keyword))]);
      const relCandidates = [];
      // 5개씩 묶어 호출
      for (let i = 0; i < seeds.length; i += 5) {
        const batch = seeds.slice(i, i + 5);
        const list = await client.getRelatedKeywords(batch);
        for (const row of (list || [])) {
          const kw = (row.relKeyword || '').trim();
          if (!kw) continue;
          const key = norm(kw);
          if (!key || expandedNames.has(key)) continue;
          const pc = parseVol(row.monthlyPcQcCnt);
          const mo = parseVol(row.monthlyMobileQcCnt);
          const tot = pc + mo;
          if (tot < MIN_MONTHLY_VOL) continue;
          expandedNames.add(key);
          relCandidates.push({
            keyword: kw, source: '키워드도구',
            campaignName: '', adgroupName: '', campaignType: '',
            currentClk: 0, currentCost: 0, currentPurchase: 0, currentRoas: 0,
            monthlyPc: pc, monthlyMobile: mo, monthlyTotal: tot, compIdx: row.compIdx || '',
            action: '신규 키워드 등록 검토',
            reason: `전환 우수 키워드 연관 · 월 검색량 ${fmt(tot)} (PC ${fmt(pc)}/MO ${fmt(mo)}, 경쟁 ${row.compIdx || '-'})`,
            score: tot,
          });
        }
      }
      relCandidates.sort((a, b) => b.score - a.score);
      // 전환검색어(소스1) 우선, 그 뒤 키워드도구(소스2)
      expansion.push(...relCandidates);
    } catch (e) {
      console.log('  ⚠️ 키워드도구 보강 실패:', e.message);
    }
  }

  // 카테고리별 상한
  const upsellTop = upsell.slice(0, MAX_PER_CATEGORY);
  const downsellTop = downsell.slice(0, MAX_PER_CATEGORY);
  const expansionTop = expansion.slice(0, MAX_PER_CATEGORY + 20);

  const summary = {
    upsellCount: upsellTop.length,
    downsellCount: downsellTop.length,
    expansionCount: expansionTop.length,
    // 증액 후보의 현재 비용 합 (확대 시 추가 투입 여력 가늠)
    upsellCurrentCost: upsellTop.reduce((s, d) => s + (d.cost || 0), 0),
    upsellPurchaseAmt: upsellTop.reduce((s, d) => s + (d.purchaseAmt || 0), 0),
    // 감액 후보의 낭비/비효율 비용 합
    downsellWasteCost: downsellTop.reduce((s, d) => s + (d.cost || 0), 0),
    expansionConvertingQueries: expansionTop.filter(e => e.source === '전환검색어').length,
    expansionToolIdeas: expansionTop.filter(e => e.source === '키워드도구').length,
  };

  return { upsell: upsellTop, downsell: downsellTop, expansion: expansionTop, meta, summary };
}

module.exports = { analyzeAccount, analyzeSync };
