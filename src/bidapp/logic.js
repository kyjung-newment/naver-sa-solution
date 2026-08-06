// ─── 이고진 입찰관리: 핵심 비즈니스 로직 (순수 함수 — 단위테스트 대상) ───
// 블렌딩 ROAS / 판정 / 핵심소재 / 권장입찰가 계산.
// DB·API 의존 없음. engine.js 와 scripts/test-bid-logic.js 에서 사용.

// 분류별 기본 규칙 [목표ROAS계수 / 증액률 / 감액률]
const DEFAULT_CATEGORY_RULES = {
  '일반':     { coef: 1.0, up: 0.10, down: 0.10 },
  '집중홍보': { coef: 0.8, up: 0.10, down: 0.05 },
  '신제품':   { coef: 0.7, up: 0.10, down: 0.00 }, // 등록 4주 감액금지
  '재고소진': { coef: 0.7, up: 0.15, down: 0.05 },
  '시즌상품': { coef: 0.8, up: 0.10, down: 0.05 },
  '슈퍼적립': { coef: 0.9, up: 0.10, down: 0.05 },
  '유입확대': { coef: 0.7, up: 0.15, down: 0.00 },
  '테스트':   { coef: 1.0, up: 0.00, down: 0.00 },
  '비주력':   { coef: 1.2, up: 0.05, down: 0.15 },
};
const CATEGORIES = Object.keys(DEFAULT_CATEGORY_RULES);

// 조정 파라미터 기본값 (전부 설정 화면에서 수정 가능)
const DEFAULT_SETTINGS = {
  blend_recent_weight: 40, // 블렌딩 1주차(최신 완료 주) 비중 N% (0~100 정수), 2~4주차 = 100-N%
  volume_drop_threshold: 0.10, // 볼륨하락 임계: 최신주 매출 < 기준매출×(1-임계) 이면 감액 보류
  band_up: 0.10,           // 판정 밴드 상단 +10%
  band_down: 0.10,         // 판정 밴드 하단 -10%
  core_share: 0.70,        // 핵심소재: 4주 누적 매출 상위 누적기여 70%
  core_down_cap: 0.05,     // 핵심소재 감액 상한 5%
  min_bid: 300,            // 최저입찰가
  min_cost: 30000,         // 최소 데이터 기준: 4주 누적비용
  rank_floor: 6,           // 노출순위 하한 (이보다 순위값이 크면=낮으면 감액 보류)
  default_target_roas: 5.5, // 기본 목표ROAS 550%
  adjust_mode: 'approval', // 'auto'(자동 적용) | 'approval'(승인 후 적용)
  force_approval_delta: 0.20, // 이 폭 초과 변경은 auto여도 무조건 승인
  daily_cost_mult: 2.0,    // 일간 트리거: 일 비용 > 4주 일평균 × 200%
  daily_roas_mult: 0.5,    // 일간 트리거: 당일 ROAS < 보정목표 × 50%
  // 수집(추출)·조정에서 제외할 캠페인 (줄당 1개, 캠페인명 "포함" 일치 시 제외 — 설정 화면에서 수정)
  excluded_campaigns: '[이고진_카테고리] 키워드\n[이고진] 키워드\n#렌탈 벌크\n#전체 벌크',
};

/** 제외 캠페인 설정(멀티라인 문자열) → 패턴 배열 */
function parseExcludedCampaigns(raw) {
  return String(raw || '').split('\n').map(s => s.trim()).filter(Boolean);
}

/** 캠페인명이 제외 패턴에 걸리는지 (부분 포함 일치) */
function isExcludedCampaign(campaignName, patterns) {
  if (!patterns || !patterns.length) return false;
  const name = String(campaignName || '');
  return patterns.some(p => name.includes(p));
}

// 판정 코드
const VERDICT = {
  UP: '증액',
  DOWN: '감액',
  DOWN_HOLD: '감액보류(볼륨하락)',
  KEEP: '유지',
  NO_DATA: '데이터부족',
  KEEP_NO_DOWN: '유지-감액금지',
  KEEP_RANK: '유지-순위저하',
};

/**
 * 블렌딩 ROAS — 2구간 가변 비율
 * weeks: [{cost, revenue}, ...] index 0=1주차(최신 완료 주), 1~3=2~4주차 합산
 * N = blend_recent_weight(%): 블렌딩 = (N%×매출₁ + (100-N)%×매출₂₋₄) ÷ (N%×비용₁ + (100-N)%×비용₂₋₄)
 * @returns {number|null} 분모 0이면 null (판단 불가)
 */
function blendedRoas(weeks, s = DEFAULT_SETTINGS) {
  const wk = (i) => weeks[i] || { cost: 0, revenue: 0 };
  const n = Math.max(0, Math.min(100, parseFloat(s.blend_recent_weight) || 0)) / 100;
  const rev24 = wk(1).revenue + wk(2).revenue + wk(3).revenue;
  const cost24 = wk(1).cost + wk(2).cost + wk(3).cost;
  const num = n * wk(0).revenue + (1 - n) * rev24;
  const den = n * wk(0).cost + (1 - n) * cost24;
  if (den <= 0) return null;
  return num / den;
}

/**
 * 매출볼륨 감액 보류 (판정 후처리): 감액 판정이면서 기준매출 대비 최신주 매출이
 * 임계 이상 하락한 경우 '감액보류(볼륨하락)' 로 전환 → 자동 적용 금지, 승인 대기.
 * 증액·유지는 그대로 통과. 기준매출 null(전월 데이터 없는 신규 소재)은 미적용.
 */
function volumeHold(verdict, week1Revenue, baselineWeeklyRevenue, s = DEFAULT_SETTINGS) {
  if (verdict !== VERDICT.DOWN) return verdict;
  if (baselineWeeklyRevenue == null) return verdict;
  const baseline = parseFloat(baselineWeeklyRevenue);
  if (!(baseline > 0)) return verdict;
  if ((week1Revenue || 0) < baseline * (1 - s.volume_drop_threshold)) return VERDICT.DOWN_HOLD;
  return verdict;
}

/** 기준매출(주간 환산): 전월 매출 합계 ÷ 전월 일수 × 7, 100원 단위 반올림 */
function calcBaselineWeekly(monthRevenue, daysInMonth) {
  if (!(daysInMonth > 0)) return null;
  return Math.round((monthRevenue / daysInMonth) * 7 / 100) * 100;
}

/**
 * 핵심소재 판별: 4주 누적 매출 내림차순으로 누적기여 core_share(70%) 이내 소재
 * items: [{id, revenue4w}] → Set(id)
 */
function coreMaterialIds(items, coreShare = DEFAULT_SETTINGS.core_share) {
  const total = items.reduce((a, m) => a + (m.revenue4w || 0), 0);
  const core = new Set();
  if (total <= 0) return core;
  const sorted = [...items].sort((a, b) => (b.revenue4w || 0) - (a.revenue4w || 0));
  let cum = 0;
  for (const m of sorted) {
    if (!(m.revenue4w > 0)) break;
    if (cum / total >= coreShare) break; // 이미 70% 도달 → 이후 소재는 비핵심
    core.add(m.id);
    cum += m.revenue4w;
  }
  return core;
}

/** 10원 단위 반올림 */
function roundBid10(v) {
  return Math.round(v / 10) * 10;
}

/**
 * 판정 로직 (프롬프트 ③ 의사코드 그대로)
 * @param {object} p
 *  - blended: 블렌딩ROAS (null=판단불가)
 *  - targetRoas: 소재별 목표ROAS (예: 5.5 = 550%)
 *  - rule: {coef, up, down} 분류 규칙
 *  - cost4w: 4주 누적비용
 *  - rank1w: 1주차 평균노출순위 (0=데이터없음)
 *  - isCore: 핵심소재 여부
 *  - currentBid: 현재 입찰가
 * @param {object} s 설정
 * @returns {{verdict, adjustRate, adjustedTarget, recommendedBid}}
 */
function judge(p, s = DEFAULT_SETTINGS) {
  const adjustedTarget = p.targetRoas * p.rule.coef; // 보정목표
  const out = (verdict, rate) => {
    let bid = p.currentBid;
    if (rate) bid = Math.max(roundBid10(p.currentBid * (1 + rate)), s.min_bid);
    else bid = Math.max(roundBid10(p.currentBid), s.min_bid);
    return { verdict, adjustRate: rate || 0, adjustedTarget, recommendedBid: bid };
  };

  if (p.cost4w < s.min_cost) return out(VERDICT.NO_DATA, 0);
  if (p.blended == null) return out(VERDICT.NO_DATA, 0); // 분모 0 → 판단 불가
  if (p.blended >= adjustedTarget * (1 + s.band_up)) {
    if (!(p.rule.up > 0)) return out(VERDICT.KEEP, 0); // 증액률 0 → 유지
    return out(VERDICT.UP, p.rule.up);
  }
  if (p.blended < adjustedTarget * (1 - s.band_down)) {
    if (!(p.rule.down > 0)) return out(VERDICT.KEEP_NO_DOWN, 0);       // 감액금지
    if (p.rank1w > s.rank_floor) return out(VERDICT.KEEP_RANK, 0);     // 순위 저하 → 감액 보류
    const downRate = p.isCore ? Math.min(p.rule.down, s.core_down_cap) : p.rule.down;
    return out(VERDICT.DOWN, -downRate);
  }
  return out(VERDICT.KEEP, 0);
}

// ─── 주차 유틸 (KST 기준, 월요일 시작) ─────────────────────────────
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** KST 현재 시각 Date (UTC 필드에 KST 값이 들어간 Date) */
function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

/** 주어진 날짜(YYYY-MM-DD)가 속한 주의 월요일 */
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=일
  const diff = dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + diff);
  return fmtDate(d);
}

/**
 * 최근 4개 완료 주 (KST 기준). index 0=1주차(최신 완료 주 월요일) … 3=4주차
 * @returns {[{start, end}]} start=월요일, end=일요일 (YYYY-MM-DD)
 */
function last4Weeks(base = null) {
  const now = base ? new Date(base + 'T00:00:00Z') : nowKST();
  // 이번 주 월요일 → 최신 완료 주는 그 전 주
  const thisMon = new Date(mondayOf(fmtDate(now)) + 'T00:00:00Z');
  const weeks = [];
  for (let i = 1; i <= 4; i++) {
    const start = new Date(thisMon);
    start.setUTCDate(start.getUTCDate() - 7 * i);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);
    weeks.push({ start: fmtDate(start), end: fmtDate(end) });
  }
  return weeks; // [1주차, 2주차, 3주차, 4주차]
}

module.exports = {
  DEFAULT_CATEGORY_RULES, CATEGORIES, DEFAULT_SETTINGS, VERDICT,
  blendedRoas, volumeHold, calcBaselineWeekly, coreMaterialIds, roundBid10, judge,
  parseExcludedCampaigns, isExcludedCampaign,
  mondayOf, last4Weeks, nowKST, fmtDate,
};
