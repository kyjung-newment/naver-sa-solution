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
// ─── 기능별 사전 필터 (사용자 지정) ─────────────────────────────────
const DOWNSELL_MIN_COST = 10000;        // 감액: 비용 1만원 미만 제외
const DISCOVERY_SEED_MIN_ROAS = 300;    // 발굴: ROAS 300% 이상 키워드만 소스로
const ONECLICK_MIN_CLICKS = 1;          // 원클릭: 클릭 1 미만 제외
// 마스터 미동기화로 이름이 ID로 남은 항목 탐지 (그룹 grp-/cmp-, 키워드 nkw- 등)
const UNRESOLVED_RE = /^(grp|cmp|adg|nkw|ncc|nccc|nad|nccad|bnc|cnv)[-_]/i;
const isIdLike = (s) => !s || s === '-' || UNRESOLVED_RE.test(String(s));

// 증액 트랙별 파라미터
// growth=클릭수 증가율, cpcInflation=입찰 상향에 따른 한계 CPC 상승, cvrDecay=한계 전환율 감쇠
// (광고비 증가 → 전환율 낮은 클릭도 유입 → ROAS·전환율 소폭 감소를 반영)
const TRACK = {
  hold_roas:   { incPct: 0.30, growth: 0.30, cpcInflation: 1.05, cvrDecay: 0.90, label: 'ROAS 유지 증액' },
  grow_volume: { incPct: 0.80, growth: 0.80, cpcInflation: 1.12, cvrDecay: 0.72, label: '볼륨 성장(ROAS 최소화)' },
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
// 선택 채널 정규화 ('powerlink'/'shopping' 또는 한글 → 캠페인유형 라벨 배열)
function normalizeChannels(channels) {
  if (!Array.isArray(channels) || channels.length === 0) return ['파워링크', '쇼핑검색'];
  const map = { powerlink: '파워링크', shopping: '쇼핑검색', '파워링크': '파워링크', '쇼핑검색': '쇼핑검색' };
  const out = channels.map(c => map[c]).filter(Boolean);
  return out.length ? out : ['파워링크', '쇼핑검색'];
}

// 증액 투영 (클릭수 증가 × CPC × 전환율 기반, 한계 전환율 감쇠로 ROAS 소폭 하락)
// 필터: 전환수 0 제외 (전환 데이터가 있어야 AOV·전환율 추정 가능)
function projectUpsellItem(d, track, key) {
  const C = d.clk || 0;                 // 현재 클릭수
  const cost = d.cost || 0;
  const cv = d.purchaseCnt || 0;        // 현재 전환수
  const R = d.purchaseAmt || 0;         // 현재 매출
  const cpc = C > 0 ? (cost / C) : (d.cpc || 0);
  const cvr = C > 0 ? (cv / C) : 0;     // 현재 전환율
  const aov = cv > 0 ? (R / cv) : 0;    // 전환당 매출(AOV)
  const p = TRACK[track] || TRACK.hold_roas;

  const addClicks = Math.round(C * p.growth);          // 클릭수 증가
  const marginalCpc = Math.round(cpc * p.cpcInflation); // 입찰 상향 → 한계 CPC 상승
  const addSpend = addClicks * marginalCpc;            // 추가 투입(=증가 클릭 × 한계 CPC)
  const marginalCvr = cvr * p.cvrDecay;                // 한계 전환율(소폭 감소)
  const addConv = addClicks * marginalCvr;             // 추가 전환수(추정)
  const uplift = Math.round(addConv * aov);            // 예상 상승 매출
  const newCost = cost + addSpend, newRev = R + uplift;
  const expRoas = newCost > 0 ? Math.round(newRev / newCost * 100) : 0;

  return {
    name: d.name || key, campaignName: d.campaignName || '', adgroupName: d.adgroupName || '', campaignType: d.campaignType || '',
    clk: C, cost, cpc: Math.round(cpc), cvr: +(cvr * 100).toFixed(2), roas: d.roas || 0, purchaseCnt: cv, purchaseAmt: R,
    addClicks, marginalCpc, addSpend, recBudget: newCost,
    addConversions: +addConv.toFixed(1), expRevenueUplift: uplift, expRoas,
    track, trackLabel: p.label,
    // 호환 필드
    currentCost: cost, currentRoas: d.roas || 0,
    action: `클릭 +${fmt(addClicks)}회(입찰 상향) → 추가비용 ${won(addSpend)}`,
    reason: `현재 CVR ${(cvr * 100).toFixed(2)}% · CPC ${won(Math.round(cpc))} 기준, 클릭 +${fmt(addClicks)}회 시 한계전환율 ${(marginalCvr * 100).toFixed(2)}%(소폭↓) 가정 → 매출 +${won(uplift)}, 예상 ROAS ${expRoas}% (현재 ${fmt(d.roas || 0)}%)`,
    score: uplift,
  };
}

// 차원 소스에서 증액 후보 생성 (전환수 0 제외 + 성과 우수=계정평균 ROAS 이상)
function buildUpsellDim(src, track, bench, opts = {}) {
  const out = [];
  for (const [k, d] of Object.entries(src || {})) {
    if (!d) continue;
    if (!opts.allowId && isIdLike(d.name)) continue;  // ID로만 인식되는 항목 제외(삭제)
    if ((d.purchaseCnt || 0) <= 0) continue;          // 증액 필터: 전환 0 제외
    if ((d.clk || 0) < MIN_CLICKS_UPSELL) continue;
    if ((d.cost || 0) <= 0) continue;
    if (bench.avgRoas > 0 && (d.roas || 0) < bench.avgRoas) continue; // 성과 우수만
    out.push(projectUpsellItem(d, track, k));
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, opts.limit || MAX_PER_CATEGORY);
}

function sumUpsell(items) {
  const totalAddSpend = items.reduce((s, x) => s + (x.addSpend || 0), 0);
  const totalExpUplift = items.reduce((s, x) => s + (x.expRevenueUplift || 0), 0);
  const currentCost = items.reduce((s, x) => s + (x.cost || 0), 0);
  const currentPurchaseAmt = items.reduce((s, x) => s + (x.purchaseAmt || 0), 0);
  const blendedExpRoas = (currentCost + totalAddSpend) > 0
    ? Math.round((currentPurchaseAmt + totalExpUplift) / (currentCost + totalAddSpend) * 100) : 0;
  return { count: items.length, totalAddSpend, totalExpUplift, currentCost, currentPurchaseAmt, blendedExpRoas };
}

// 그룹/키워드(상품검색어)/기기 차원별 증액 분석 (채널 선택)
function analyzeUpsell(data, opts = {}) {
  const bench = benchmarks(data);
  const track = TRACK[opts.track] ? opts.track : 'hold_roas';
  const channels = normalizeChannels(opts.channels);
  const inCh = (d) => channels.includes(d.campaignType);
  const filt = (src) => Object.fromEntries(Object.entries(src || {}).filter(([, d]) => inCh(d)));

  const groups = buildUpsellDim(filt(data.byAdgroup), track, bench);
  const keywords = buildUpsellDim(filt(data.byKeyword), track, bench);
  // 기기별: 계정 전체(채널 분리 미보유) — PC/모바일 라벨 부여
  const devSrc = {};
  for (const [k, d] of Object.entries(data.byDevice || {})) {
    devSrc[k] = { ...d, name: (k === 'PC' || k === 'P') ? 'PC' : '모바일', campaignType: '' };
  }
  const devices = buildUpsellDim(devSrc, track, { avgRoas: 0 }, { limit: 4 }); // 기기는 ROAS 필터 없이

  const summary = Object.assign({ track, trackLabel: (TRACK[track] || TRACK.hold_roas).label, channels }, sumUpsell(groups));
  return { groups, keywords, devices, items: groups, summary, bench };
}

// ─── 2) 감액 (Downselling) ──────────────────────────────────────────
// 모드 A: 비효율 (전환 없음/저효율)
function downsellInefficiency(data, bench) {
  const out = [];
  for (const d of Object.values(data.byKeyword || {})) {
    if (!d || (d.cost || 0) < DOWNSELL_MIN_COST || (d.clk || 0) < MIN_CLICKS_DOWNSELL) continue; // 감액 필터: 비용 1만원 미만 제외
    if (isIdLike(d.name)) continue; // ID로만 인식되는 항목 제외(삭제)
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
  const kws = Object.values(data.byKeyword || {}).filter(d => (d.cost || 0) >= DOWNSELL_MIN_COST && !isIdLike(d.name)); // 비용 1만원 미만 + ID항목 제외
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

// 기기별 비효율 감액 (PC/모바일) — 매체이름은 SA API 미제공이라 기기로 대체
function downsellDevices(data, bench) {
  const out = [];
  for (const [k, d] of Object.entries(data.byDevice || {})) {
    if ((d.cost || 0) < DOWNSELL_MIN_COST) continue;
    const wasteful = (d.purchaseCnt || 0) === 0;
    const lowEff = bench.avgRoas > 0 && (d.roas || 0) < bench.avgRoas * LOW_ROAS_MULT;
    if (!wasteful && !lowEff) continue;
    const cut = wasteful ? (d.cost || 0) : Math.round((d.cost || 0) * 0.5);
    out.push({
      name: (k === 'PC' || k === 'P') ? 'PC' : '모바일', campaignName: '', adgroupName: '',
      cost: d.cost || 0, roas: d.roas || 0, purchaseCnt: d.purchaseCnt || 0,
      cutSpend: cut, lostRevenue: wasteful ? 0 : Math.round((d.purchaseAmt || 0) * 0.5),
      action: wasteful ? '기기 입찰 가중치 OFF/하향' : '기기 입찰 가중치 하향(약 -50%)',
      reason: wasteful ? `비용 ${won(d.cost)} · 전환 0 — 기기 비효율` : `ROAS ${fmt(d.roas)}% (계정평균 절반 미만) — 기기 비효율`,
    });
  }
  return out.sort((a, b) => b.cutSpend - a.cutSpend);
}

// 감액 적용 후 예상 전체 ROAS (선택 키워드 비용·매출 차감)
function projectedAccountRoas(bench, cutSpend, lostRevenue) {
  const projCost = Math.max(0, bench.totalCost - cutSpend);
  const projRev = Math.max(0, bench.totalPurchaseAmt - lostRevenue);
  return projCost > 0 ? Math.round(projRev / projCost * 100) : 0;
}

function analyzeDownsell(data, opts = {}) {
  const bench = benchmarks(data);
  const currentRoas = bench.totalCost > 0 ? Math.round(bench.totalPurchaseAmt / bench.totalCost * 100) : 0;
  if (opts.mode === 'budget_target') {
    const r = downsellBudgetTarget(data, bench, opts);
    r.summary.currentRoas = currentRoas;
    r.summary.projectedRoas = projectedAccountRoas(bench, r.summary.achievedReduction || 0, r.summary.estRevenueLoss || 0);
    return { items: r.items, devices: downsellDevices(data, bench), summary: r.summary, bench };
  }
  const items = downsellInefficiency(data, bench);
  // 정렬: 캠페인 → 광고그룹 → 검색어(키워드)
  items.sort((a, b) => (a.campaignName || '').localeCompare(b.campaignName || '') || (a.adgroupName || '').localeCompare(b.adgroupName || '') || (a.name || '').localeCompare(b.name || ''));
  const totalCutSpend = items.reduce((s, x) => s + (x.cutSpend || 0), 0);
  const estRevenueLoss = items.reduce((s, x) => s + (x.lostRevenue || 0), 0);
  const summary = {
    mode: 'inefficiency',
    count: items.length,
    totalCutSpend, estRevenueLoss,
    zeroConvCount: items.filter(x => (x.purchaseCnt || 0) === 0).length,
    currentRoas,
    projectedRoas: projectedAccountRoas(bench, totalCutSpend, estRevenueLoss),
  };
  return { items, devices: downsellDevices(data, bench), summary, bench };
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
  // 발굴 필터: ROAS 300% 이상 키워드만 소스(seed)로 사용
  const kwSorted = Object.values(data.byKeyword || {})
    .filter(d => d && d.name && !UNRESOLVED_RE.test(d.name) && (d.purchaseCnt || 0) >= 1 && (d.roas || 0) >= DISCOVERY_SEED_MIN_ROAS)
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
// 계정 성과 요약 (원클릭 엑셀 전 미리보기용)
function performanceSummary(data) {
  const total = data.total || {};
  const topN = (obj, n, withName) => Object.entries(obj || {})
    .map(([k, d]) => ({ key: k, name: withName ? (d.name || k) : k, imp: d.imp || 0, clk: d.clk || 0, cost: d.cost || 0, roas: d.roas || 0, purchaseCnt: d.purchaseCnt || 0, purchaseAmt: d.purchaseAmt || 0, ctr: d.ctr || 0, cpc: d.cpc || 0 }))
    .filter(x => x.cost > 0).sort((a, b) => b.cost - a.cost).slice(0, n);
  return {
    total: { imp: total.imp || 0, clk: total.clk || 0, cost: total.cost || 0, ctr: total.ctr || 0, cpc: total.cpc || 0, roas: total.roas || 0, purchaseCnt: total.purchaseCnt || 0, purchaseAmt: total.purchaseAmt || 0 },
    byCampaignType: Object.entries(data.byCampaignType || {}).map(([k, d]) => ({ name: k, cost: d.cost || 0, clk: d.clk || 0, roas: d.roas || 0, purchaseAmt: d.purchaseAmt || 0 })).sort((a, b) => b.cost - a.cost),
    byCampaign: topN(data.byCampaign, 10, true),
    byDevice: Object.entries(data.byDevice || {}).map(([k, d]) => ({ name: (k === 'PC' || k === 'P') ? 'PC' : '모바일', cost: d.cost || 0, clk: d.clk || 0, roas: d.roas || 0, purchaseAmt: d.purchaseAmt || 0 })),
  };
}

async function analyzeAccount(data, client, opts = {}) {
  // 원클릭 필터: 클릭 1 미만 데이터 제외
  const fdata = {
    ...data,
    byKeyword: Object.fromEntries(Object.entries(data.byKeyword || {}).filter(([, d]) => (d.clk || 0) >= ONECLICK_MIN_CLICKS)),
    byAdgroup: Object.fromEntries(Object.entries(data.byAdgroup || {}).filter(([, d]) => (d.clk || 0) >= ONECLICK_MIN_CLICKS)),
  };
  const up = analyzeUpsell(fdata, { track: opts.track || 'hold_roas', channels: ['파워링크', '쇼핑검색'] });
  const down = analyzeDownsell(fdata, { mode: 'inefficiency' });

  // 업셀 적용 시 상향 가능 전체 ROAS (증액 후 블렌디드)
  const upBlendedRoas = up.summary.blendedExpRoas || 0;

  const summary = {
    upsellCount: up.groups.length,
    downsellCount: down.items.length,
    upsellCurrentCost: up.summary.currentCost,
    upsellAddSpend: up.summary.totalAddSpend,
    upsellExpUplift: up.summary.totalExpUplift,
    upsellPurchaseAmt: up.summary.currentPurchaseAmt,
    upsellBlendedRoas: upBlendedRoas,
    downsellWasteCost: down.summary.totalCutSpend || 0,
    downsellProjectedRoas: down.summary.projectedRoas || 0,
    downsellCurrentRoas: down.summary.currentRoas || 0,
    inefficientCount: down.items.length,
    inefficientCost: down.summary.totalCutSpend || 0,
  };
  // 원클릭 번들 엑셀의 증액 시트는 '그룹 단위'를 사용 (키워드 발굴 제거)
  return { upsell: up.groups, upsellKeywords: up.keywords, upsellDevices: up.devices, downsell: down.items, downsellDevices: down.devices, meta: up.bench, summary, performance: performanceSummary(fdata) };
}

module.exports = {
  analyzeAccount,
  analyzeUpsell,
  analyzeDownsell,
  analyzeDiscovery,
  benchmarks,
  TRACK,
};
