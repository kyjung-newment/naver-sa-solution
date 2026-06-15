/**
 * 성과개선 전략 엔진
 *
 *  1) 증액 (Upselling)   — 투트랙: ROAS 유지 증액 / 볼륨 성장(ROAS 최소화)
 *                          증액 제안 예산 · 예상 상승 매출 · 예상 ROAS 산출
 *  2) 감액 (Downselling) — 모드: 비효율 감액 / 재정 목표 감액(목표 절감액까지 손실 최소 컷)
 *  3) 키워드 발굴 (Discovery) — 파워링크/쇼핑 채널 + 성격(기능성/시즌성/연관/지역성) 필터
 *  4) 원클릭(종합)       — 1·2·3 요약 (월간 제안 리포트 폼)
 *
 * 모든 임계값은 '계정 평균' 대비 상대값으로 계산하여 업종/규모와 무관하게 동작한다.
 */

// ─── 임계값 ─────────────────────────────────────────────────────────
const MIN_CLICKS_UPSELL = 10;
const MIN_CLICKS_DOWNSELL = 15;
const MIN_CLICKS_EXPAND = 3;
const GOOD_ROAS_MULT = 1.3;
const GOOD_ROAS_FLOOR = 300;
const HIGH_CTR_MULT = 1.2;
const LOW_ROAS_MULT = 0.5;
const RANK_ROOM = 1.5;
const MAX_PER_CATEGORY = 40;
const MIN_MONTHLY_VOL = 50;
const UNRESOLVED_RE = /^(nkw|ncc|nad|nccad)[-_]/i;

// 증액 트랙별 파라미터
const TRACK = {
  hold_roas:   { incPct: 0.30, label: 'ROAS 유지 증액' },
  grow_volume: { incPct: 0.80, label: '볼륨 성장(ROAS 최소화)' },
};

// 키워드 성격 사전 (디스커버리 카테고리)
const LEX = {
  seasonal: ['봄','여름','가을','겨울','연말','신년','새해','명절','설날','추석','크리스마스','발렌타인','빼빼로','블랙프라이데이','신학기','입학','졸업','휴가','장마','환절기','김장','수능','할로윈','어린이날','어버이날','선물','세일','할인','시즌'],
  functional: ['방수','무선','대용량','초경량','저렴','가성비','추천','사용법','효과','성분','후기','비교','순위','정품','국산','프리미엄','휴대용','다기능','자동','강력','오래','빠른','조용','친환경','무료','정기','구독','렌탈','대여','수리','설치','as','a/s','기능','전용','호환'],
  local: ['서울','부산','대구','인천','광주','대전','울산','세종','경기','강원','충북','충남','전북','전남','경북','경남','제주','강남','강북','홍대','신촌','수원','성남','용인','분당','일산','판교','잠실','명동','이태원','근처','동네','지역','배달','방문','출장'],
};

const fmt = n => Number(n || 0).toLocaleString('ko-KR');
const won = n => `₩${fmt(n)}`;
const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();

function parseVol(v) {
  if (v == null) return 0;
  const s = String(v).replace(/[,\s]/g, '');
  if (s.startsWith('<')) return 5;
  const n = parseInt(s);
  return isNaN(n) ? 0 : n;
}

// 키워드 텍스트 → 성격 태그 배열
function characterize(text) {
  const t = String(text || '');
  const tags = [];
  for (const cat of ['local', 'seasonal', 'functional']) {
    if (LEX[cat].some(w => t.includes(w))) tags.push(cat);
  }
  return tags;
}

// 캠페인유형 → 채널 키
function channelOf(campaignType) {
  if (campaignType === '쇼핑검색') return 'shopping';
  if (campaignType === '파워링크') return 'powerlink';
  return 'other';
}

// 공통 키워드 아이템 변환
function kwItem(d) {
  return {
    scope: '키워드', name: d.name,
    campaignName: d.campaignName || '', adgroupName: d.adgroupName || '', campaignType: d.campaignType || '',
    imp: d.imp || 0, clk: d.clk || 0, cost: d.cost || 0, ctr: d.ctr || 0, cpc: d.cpc || 0,
    avgRank: d.avgRank || 0, roas: d.roas || 0, purchaseCnt: d.purchaseCnt || 0, purchaseAmt: d.purchaseAmt || 0,
  };
}

// ─── 벤치마크 ───────────────────────────────────────────────────────
function benchmarks(data) {
  const total = data.total || {};
  return {
    avgRoas: total.roas || 0,
    avgCtr: total.ctr || 0,
    avgCpc: total.cpc || 0,
    totalCost: total.cost || 0,
    totalPurchaseAmt: total.purchaseAmt || 0,
  };
}

// ─── 1) 증액 (Upselling) ────────────────────────────────────────────
function baseUpsell(data, bench) {
  const goodRoasBar = Math.max(GOOD_ROAS_FLOOR, bench.avgRoas * GOOD_ROAS_MULT);
  const out = [];
  for (const d of Object.values(data.byKeyword || {})) {
    if (!d || (d.cost || 0) <= 0 || (d.clk || 0) < MIN_CLICKS_UPSELL) continue;
    if ((d.purchaseCnt || 0) < 1) continue;
    const efficient = (d.roas || 0) >= goodRoasBar;
    const engaging = bench.avgCtr > 0 && (d.ctr || 0) >= bench.avgCtr * HIGH_CTR_MULT && (d.roas || 0) >= bench.avgRoas;
    if (!efficient && !engaging) continue;
    const it = kwItem(d);
    it.room = (d.avgRank || 0) === 0 || (d.avgRank || 0) > RANK_ROOM;
    it.score = (d.roas || 0) * (d.cost || 0);
    out.push(it);
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// 트랙별 증액 투영 (증액 예산 / 예상 상승 매출 / 예상 ROAS)
function projectUpsell(it, track, bench) {
  const C = it.cost || 0, A = it.purchaseAmt || 0, R = it.roas || 0;
  const p = TRACK[track] || TRACK.hold_roas;
  const addSpend = Math.round(C * p.incPct);
  let expUplift, expRoas, marginalRoas;
  if (track === 'grow_volume') {
    // 한계 ROAS = max(계정평균, 150%, 현재의 60%) → 추가 예산은 최소 효율 유지
    marginalRoas = Math.max(bench.avgRoas, 150, Math.round(R * 0.6));
    expUplift = Math.round(addSpend * marginalRoas / 100);
    const newCost = C + addSpend, newRev = A + expUplift;
    expRoas = newCost > 0 ? Math.round(newRev / newCost * 100) : 0;
  } else {
    // ROAS 유지 → 매출도 비례 증가
    marginalRoas = R;
    expUplift = Math.round(A * p.incPct);
    expRoas = R;
  }
  return {
    ...it,
    track, trackLabel: p.label,
    currentCost: C, currentRoas: R,
    addSpend, recBudget: C + addSpend,
    expRevenueUplift: expUplift, expRoas, marginalRoas,
    action: track === 'grow_volume'
      ? `예산 +${Math.round(p.incPct * 100)}% (볼륨 성장)`
      : `예산 +${Math.round(p.incPct * 100)}% (ROAS 유지)`,
    reason: track === 'grow_volume'
      ? `ROAS ${fmt(R)}% 우수 → 추가예산 ${won(addSpend)} 투입 시 한계ROAS ${fmt(marginalRoas)}% 가정, 매출 +${won(expUplift)} (블렌디드 ROAS ${fmt(expRoas)}%)`
      : `ROAS ${fmt(R)}% 유지하며 예산 ${won(addSpend)} 증액 → 매출 +${won(expUplift)} 예상`,
  };
}

function analyzeUpsell(data, opts = {}) {
  const bench = benchmarks(data);
  const track = TRACK[opts.track] ? opts.track : 'hold_roas';
  const base = baseUpsell(data, bench).slice(0, MAX_PER_CATEGORY);
  const items = base.map(it => projectUpsell(it, track, bench));
  const summary = {
    track, trackLabel: (TRACK[track] || TRACK.hold_roas).label,
    count: items.length,
    totalAddSpend: items.reduce((s, x) => s + (x.addSpend || 0), 0),
    totalExpUplift: items.reduce((s, x) => s + (x.expRevenueUplift || 0), 0),
    currentCost: items.reduce((s, x) => s + (x.currentCost || 0), 0),
    currentPurchaseAmt: items.reduce((s, x) => s + (x.purchaseAmt || 0), 0),
  };
  summary.blendedExpRoas = (summary.currentCost + summary.totalAddSpend) > 0
    ? Math.round((summary.currentPurchaseAmt + summary.totalExpUplift) / (summary.currentCost + summary.totalAddSpend) * 100) : 0;
  return { items, summary, bench };
}

// ─── 2) 감액 (Downselling) ──────────────────────────────────────────
// 모드 A: 비효율 (전환 없음/저효율)
function downsellInefficiency(data, bench) {
  const out = [];
  for (const d of Object.values(data.byKeyword || {})) {
    if (!d || (d.cost || 0) <= 0 || (d.clk || 0) < MIN_CLICKS_DOWNSELL) continue;
    const wasteful = (d.purchaseCnt || 0) === 0;
    const lowEff = (d.roas || 0) > 0 && bench.avgRoas > 0 && (d.roas || 0) < bench.avgRoas * LOW_ROAS_MULT && (d.cost || 0) >= bench.avgCpc * 10;
    if (!wasteful && !lowEff) continue;
    const it = kwItem(d);
    if (wasteful) {
      it.cutSpend = d.cost || 0;
      it.lostRevenue = 0;
      it.action = '입찰 하향 또는 OFF';
      it.reason = `비용 ${won(d.cost)} · 클릭 ${fmt(d.clk)}회 · 전환 0 — 효율 없음`;
    } else {
      it.cutSpend = Math.round((d.cost || 0) * 0.5); // 저효율은 절반 감액 제안
      it.lostRevenue = Math.round((d.purchaseAmt || 0) * 0.5);
      it.action = '입찰 하향(약 -50%)';
      it.reason = `ROAS ${fmt(d.roas)}% (계정평균의 절반 미만) · 비용 ${won(d.cost)} — 저효율`;
    }
    it.score = it.cutSpend;
    out.push(it);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, MAX_PER_CATEGORY);
}

// 모드 B: 재정 목표 감액 (목표 절감액까지 ROAS 낮은 순으로 컷 → 매출 손실 최소화)
function downsellBudgetTarget(data, bench, opts) {
  const totalCost = bench.totalCost;
  const target = (opts.targetAmt && opts.targetAmt > 0)
    ? opts.targetAmt
    : Math.round(totalCost * (Math.max(1, Math.min(90, opts.targetPct || 10)) / 100));
  const kws = Object.values(data.byKeyword || {}).filter(d => (d.cost || 0) > 0);
  // ROAS 오름차순(낮은 효율 먼저), 동률이면 비용 큰 것 먼저
  kws.sort((a, b) => (a.roas || 0) - (b.roas || 0) || (b.cost || 0) - (a.cost || 0));
  const items = []; let saved = 0, lostRev = 0;
  for (const d of kws) {
    if (saved >= target) break;
    const it = kwItem(d);
    const fullCost = d.cost || 0;
    // 마지막 키워드는 목표 절감액까지만 부분 감액 제안 → achievedReduction이 목표를 넘지 않도록
    const remaining = Math.max(0, target - saved);
    const cut = Math.min(fullCost, remaining);
    const partial = fullCost > 0 ? (cut / fullCost) : 0;
    it.cutSpend = cut;
    it.lostRevenue = Math.round((d.purchaseAmt || 0) * partial);
    const isPartial = cut < fullCost;
    it.action = (d.purchaseCnt || 0) === 0 ? '예산 OFF' : (isPartial ? '예산 부분 컷' : '예산 컷(우선순위)');
    it.reason = `ROAS ${fmt(d.roas)}% — 감액 우선순위${isPartial ? ' (목표 도달분만 부분 감액)' : ' 상위'} (절감 ${won(it.cutSpend)} / 매출손실 ${won(it.lostRevenue)})`;
    items.push(it);
    saved += it.cutSpend; lostRev += it.lostRevenue;
  }
  return {
    items,
    summary: { mode: 'budget_target', targetReduction: target, achievedReduction: saved, estRevenueLoss: lostRev, count: items.length, totalCost },
  };
}

function analyzeDownsell(data, opts = {}) {
  const bench = benchmarks(data);
  if (opts.mode === 'budget_target') {
    const r = downsellBudgetTarget(data, bench, opts);
    return { items: r.items, summary: r.summary, bench };
  }
  const items = downsellInefficiency(data, bench);
  const summary = {
    mode: 'inefficiency',
    count: items.length,
    totalCutSpend: items.reduce((s, x) => s + (x.cutSpend || 0), 0),
    estRevenueLoss: items.reduce((s, x) => s + (x.lostRevenue || 0), 0),
    zeroConvCount: items.filter(x => (x.purchaseCnt || 0) === 0).length,
  };
  return { items, summary, bench };
}

// ─── 3) 키워드 발굴 (Discovery) ─────────────────────────────────────
function registeredSetOf(data, registeredKeywords) {
  const set = new Set();
  if (Array.isArray(registeredKeywords)) for (const k of registeredKeywords) set.add(norm(k));
  for (const d of Object.values(data.byKeyword || {})) {
    if (d && d.name && !UNRESOLVED_RE.test(d.name)) set.add(norm(d.name));
  }
  return set;
}

// 소스1: 전환 발생 미등록 검색어
function discoverySync(data, bench, registeredSet) {
  const out = []; const seen = new Set();
  for (const d of Object.values(data.byQuery || {})) {
    if (!d || !d.name) continue;
    const key = norm(d.name);
    if (!key || registeredSet.has(key) || seen.has(key)) continue;
    if ((d.clk || 0) < MIN_CLICKS_EXPAND) continue;
    const converts = (d.purchaseCnt || 0) >= 1;
    const efficient = bench.avgRoas > 0 && (d.roas || 0) >= bench.avgRoas;
    if (!converts && !efficient) continue;
    seen.add(key);
    out.push({
      keyword: d.name, source: '전환검색어', channel: channelOf(d.campaignType),
      campaignType: d.campaignType || '', characters: characterize(d.name),
      currentClk: d.clk || 0, currentCost: d.cost || 0, currentPurchase: d.purchaseCnt || 0, currentRoas: d.roas || 0,
      monthlyPc: null, monthlyMobile: null, monthlyTotal: null, compIdx: '',
      action: '정식 키워드로 등록',
      reason: converts
        ? `광고 노출 중 전환 발생 (클릭 ${fmt(d.clk)} · 구매 ${fmt(d.purchaseCnt)}) — 미등록 검색어`
        : `광고 노출 중 ROAS ${fmt(d.roas)}% (계정평균 이상) — 미등록 검색어`,
      score: (d.purchaseAmt || 0) * 10 + (d.clk || 0),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// 소스2: 키워드도구 연관 키워드 (채널별 seed)
async function discoveryEnrich(data, client, registeredSet, alreadySet) {
  if (!client || typeof client.getRelatedKeywords !== 'function') return [];
  const out = [];
  // 채널별 seed: 전환 우수 등록 키워드(텍스트)
  const seedsByChannel = { powerlink: [], shopping: [] };
  const kwSorted = Object.values(data.byKeyword || {})
    .filter(d => d && d.name && !UNRESOLVED_RE.test(d.name) && (d.purchaseCnt || 0) >= 1)
    .sort((a, b) => (b.purchaseAmt || 0) - (a.purchaseAmt || 0));
  for (const d of kwSorted) {
    const ch = channelOf(d.campaignType);
    if (ch === 'shopping' && seedsByChannel.shopping.length < 10) seedsByChannel.shopping.push(d.name);
    else if (seedsByChannel.powerlink.length < 10) seedsByChannel.powerlink.push(d.name);
  }
  const seen = new Set([...alreadySet]);
  for (const ch of ['powerlink', 'shopping']) {
    const seeds = seedsByChannel[ch];
    for (let i = 0; i < seeds.length; i += 5) {
      const batch = seeds.slice(i, i + 5);
      let list = [];
      try { list = await client.getRelatedKeywords(batch); } catch (_) { list = []; }
      for (const row of (list || [])) {
        const kw = (row.relKeyword || '').trim();
        if (!kw) continue;
        const key = norm(kw);
        if (!key || registeredSet.has(key) || seen.has(key)) continue;
        const pc = parseVol(row.monthlyPcQcCnt), mo = parseVol(row.monthlyMobileQcCnt);
        const tot = pc + mo;
        if (tot < MIN_MONTHLY_VOL) continue;
        seen.add(key);
        out.push({
          keyword: kw, source: '키워드도구', channel: ch,
          campaignType: ch === 'shopping' ? '쇼핑검색' : '파워링크', characters: characterize(kw),
          currentClk: 0, currentCost: 0, currentPurchase: 0, currentRoas: 0,
          monthlyPc: pc, monthlyMobile: mo, monthlyTotal: tot, compIdx: row.compIdx || '',
          action: '신규 키워드 등록 검토',
          reason: `전환 우수 키워드 연관 · 월 검색량 ${fmt(tot)} (PC ${fmt(pc)}/MO ${fmt(mo)}, 경쟁 ${row.compIdx || '-'})`,
          score: tot,
        });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// 채널/성격 필터
function filterDiscovery(items, channel, character) {
  let arr = items;
  if (channel && channel !== 'all') arr = arr.filter(i => i.channel === channel);
  if (character && character !== 'all') {
    if (character === 'related') arr = arr.filter(i => i.source === '키워드도구' || (i.characters || []).length === 0);
    else arr = arr.filter(i => (i.characters || []).includes(character));
  }
  return arr;
}

async function analyzeDiscovery(data, client, opts = {}) {
  const bench = benchmarks(data);
  const regSet = registeredSetOf(data, opts.registeredKeywords);
  const src1 = discoverySync(data, bench, regSet);
  const already = new Set([...regSet, ...src1.map(s => norm(s.keyword))]);
  const src2 = (opts.skipTool || !client) ? [] : await discoveryEnrich(data, client, regSet, already);
  let items = [...src1, ...src2];
  items = filterDiscovery(items, opts.channel || 'all', opts.character || 'all');
  items = items.slice(0, MAX_PER_CATEGORY + 20);
  const summary = {
    channel: opts.channel || 'all', character: opts.character || 'all',
    count: items.length,
    convertingQueries: items.filter(i => i.source === '전환검색어').length,
    toolIdeas: items.filter(i => i.source === '키워드도구').length,
    byCharacter: {
      functional: items.filter(i => (i.characters || []).includes('functional')).length,
      seasonal: items.filter(i => (i.characters || []).includes('seasonal')).length,
      local: items.filter(i => (i.characters || []).includes('local')).length,
    },
  };
  return { items, summary, bench };
}

// ─── 4) 종합 (원클릭 / 번들 엑셀용) ─────────────────────────────────
// 기존 호환: upsell/downsell/expansion 배열 + summary 반환 (upsell엔 투영 포함)
async function analyzeAccount(data, client, opts = {}) {
  const up = analyzeUpsell(data, { track: opts.track || 'hold_roas' });
  const down = analyzeDownsell(data, { mode: 'inefficiency' });
  const disc = await analyzeDiscovery(data, client, { registeredKeywords: opts.registeredKeywords, channel: 'all', character: 'all', skipTool: opts.skipTool });

  const summary = {
    upsellCount: up.items.length,
    downsellCount: down.items.length,
    expansionCount: disc.items.length,
    upsellCurrentCost: up.summary.currentCost,
    upsellAddSpend: up.summary.totalAddSpend,
    upsellExpUplift: up.summary.totalExpUplift,
    upsellPurchaseAmt: up.summary.currentPurchaseAmt,
    downsellWasteCost: down.summary.totalCutSpend || 0,
    expansionConvertingQueries: disc.summary.convertingQueries,
    expansionToolIdeas: disc.summary.toolIdeas,
  };
  // expansion 아이템을 excelReport가 쓰는 필드명으로 유지(keyword/source/monthly*/compIdx/action/reason/currentClk/currentPurchase)
  return { upsell: up.items, downsell: down.items, expansion: disc.items, meta: up.bench, summary };
}

module.exports = {
  analyzeAccount,
  analyzeUpsell,
  analyzeDownsell,
  analyzeDiscovery,
  benchmarks,
  TRACK,
};
