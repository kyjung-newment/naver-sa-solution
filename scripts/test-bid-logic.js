// ─── 이고진 입찰관리: 판정 로직 단위테스트 ──────────────────────────
// 실행: npm run test:bid  (node scripts/test-bid-logic.js)
// 프롬프트 ③ 판정 의사코드의 각 분기 케이스를 시드 데이터로 검증한다.
const assert = require('assert');
const {
  blendedRoas, volumeHold, calcBaselineWeekly, coreMaterialIds, judge, roundBid10, mondayOf, last4Weeks,
  parseExcludedCampaigns, isExcludedCampaign,
  DEFAULT_SETTINGS, DEFAULT_CATEGORY_RULES, VERDICT,
} = require('../src/bidapp/logic');

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { console.error(`  ❌ ${name}: ${e.message}`); process.exitCode = 1; }
}

const S = { ...DEFAULT_SETTINGS };
const R = DEFAULT_CATEGORY_RULES;

console.log('── 블렌딩 ROAS (2구간 가변 비율) ──');
// 1주차 100만/500만 · 2~4주차 합산 200만/700만 (2주 100만/400만 + 3주 50만/150만 + 4주 50만/150만)
const BW = [
  { cost: 1000000, revenue: 5000000 },
  { cost: 1000000, revenue: 4000000 },
  { cost: 500000, revenue: 1500000 },
  { cost: 500000, revenue: 1500000 },
];
t('N=40: (0.4×500 + 0.6×700) ÷ (0.4×100 + 0.6×200) = 620/160 = 3.875', () => {
  assert.strictEqual(blendedRoas(BW, { ...S, blend_recent_weight: 40 }).toFixed(3), '3.875');
});
t('N=0: 2~4주차만 반영 → 700/200 = 3.5', () => {
  assert.strictEqual(blendedRoas(BW, { ...S, blend_recent_weight: 0 }).toFixed(2), '3.50');
});
t('N=100: 1주차만 반영 → 500/100 = 5.0', () => {
  assert.strictEqual(blendedRoas(BW, { ...S, blend_recent_weight: 100 }).toFixed(2), '5.00');
});
t('분모 0 → null (판단 불가)', () => {
  assert.strictEqual(blendedRoas([{ cost: 0, revenue: 100 }, { cost: 0, revenue: 0 }, { cost: 0, revenue: 0 }, { cost: 0, revenue: 0 }], S), null);
});
t('N=100 이면서 1주차 비용 0 → null (2~4주차 비용 있어도 분모 0)', () => {
  assert.strictEqual(blendedRoas([{ cost: 0, revenue: 0 }, { cost: 100, revenue: 500 }, { cost: 0, revenue: 0 }, { cost: 0, revenue: 0 }], { ...S, blend_recent_weight: 100 }), null);
});

console.log('── 매출볼륨 감액 보류 ──');
// 기준매출 100만, 임계 10% → 보류선 90만
t('감액 + 최신주 매출 하락(85만 < 90만) → 감액보류(볼륨하락)', () => {
  assert.strictEqual(volumeHold(VERDICT.DOWN, 850000, 1000000, S), VERDICT.DOWN_HOLD);
});
t('감액 + 볼륨 정상(95만 ≥ 90만) → 감액 유지', () => {
  assert.strictEqual(volumeHold(VERDICT.DOWN, 950000, 1000000, S), VERDICT.DOWN);
});
t('증액 + 볼륨 하락 → 증액 그대로 (볼륨 조건 미적용)', () => {
  assert.strictEqual(volumeHold(VERDICT.UP, 850000, 1000000, S), VERDICT.UP);
});
t('기준매출 null(전월 데이터 없는 신규 소재) → 감액 그대로', () => {
  assert.strictEqual(volumeHold(VERDICT.DOWN, 0, null, S), VERDICT.DOWN);
});
t('유지 판정은 통과', () => {
  assert.strictEqual(volumeHold(VERDICT.KEEP, 0, 1000000, S), VERDICT.KEEP);
});

console.log('── 기준매출 산출 (지난 4주 평균 주간 매출) ──');
t('4주 합계 420만 → ÷28×7 = 주간 평균 1,050,000', () => {
  assert.strictEqual(calcBaselineWeekly(4200000, 28), 1050000);
});
t('4주 합계 443만 → 1,107,500 (100원 단위 반올림)', () => {
  assert.strictEqual(calcBaselineWeekly(4430000, 28), 1107500);
});
t('매출 0 → 0', () => {
  assert.strictEqual(calcBaselineWeekly(0, 28), 0);
});

console.log('── 볼륨하락 임계 일반/핵심 분리 ──');
t('일반 10% · 핵심 5% 별도 적용 (기준 100만, 최신주 93만)', () => {
  const s2 = { ...S, volume_drop_threshold: 0.10, volume_drop_threshold_core: 0.05 };
  assert.strictEqual(volumeHold(VERDICT.DOWN, 930000, 1000000, s2, true), VERDICT.DOWN_HOLD); // 핵심: 95만 미만 → 보류
  assert.strictEqual(volumeHold(VERDICT.DOWN, 930000, 1000000, s2, false), VERDICT.DOWN);     // 일반: 90만 이상 → 감액 진행
});
t('핵심소재 누적기여: 전체 1,000만 중 상위 누적 70% 도달까지 포함', () => {
  // A 500만(누적 시작 0%) 포함 → B 200만(50%) 포함 → C 100만(70% 도달) 제외
  const core = coreMaterialIds([
    { id: 'A', revenue4w: 5000000 }, { id: 'B', revenue4w: 2000000 },
    { id: 'C', revenue4w: 1000000 }, { id: 'D', revenue4w: 500000 },
  ], 0.70);
  assert.ok(core.has('A') && core.has('B') && !core.has('C') && !core.has('D'));
});
t('(참고용 함수) 기준 0 → 핵심 없음', () => {
  assert.strictEqual(coreMaterialIds([{ id: 1, revenue4w: 100 }], 0).size, 0);
});

console.log('── 핵심소재 (누적기여 70%) ──');
t('매출 상위 누적 70% 이내만 핵심', () => {
  const items = [
    { id: 1, revenue4w: 500 }, { id: 2, revenue4w: 300 }, { id: 3, revenue4w: 150 }, { id: 4, revenue4w: 50 },
  ]; // 총 1000: id1(50%) → id2(80% 도달, 시작 시점 50%<70% → 포함) → id3(시작 80%≥70% → 제외)
  const core = coreMaterialIds(items, 0.70);
  assert.ok(core.has(1) && core.has(2) && !core.has(3) && !core.has(4));
});
t('매출 전무 → 핵심 없음', () => {
  assert.strictEqual(coreMaterialIds([{ id: 1, revenue4w: 0 }]).size, 0);
});

console.log('── 판정 분기 ──');
const base = { targetRoas: 5.5, rule: R['일반'], cost4w: 100000, rank1w: 3, isCore: false, currentBid: 1000 };

t('① 4주 누적비용 < 최소기준 → 데이터부족·유지', () => {
  const j = judge({ ...base, blended: 9.9, cost4w: 29999 }, S);
  assert.strictEqual(j.verdict, VERDICT.NO_DATA);
  assert.strictEqual(j.recommendedBid, 1000);
});
t('② 블렌딩 ≥ 보정목표×1.1 → 증액 (일반 +10%)', () => {
  // 보정목표 5.5×1.0=5.5, 상단 6.05 (부동소수점 경계 회피를 위해 6.1로 검증)
  const j = judge({ ...base, blended: 6.1 }, S);
  assert.strictEqual(j.verdict, VERDICT.UP);
  assert.strictEqual(j.recommendedBid, 1100); // 1000×1.1
});
t('②-1 증액률 0 분류(테스트)는 상단 초과여도 유지', () => {
  const j = judge({ ...base, blended: 9.0, rule: R['테스트'] }, S);
  assert.strictEqual(j.verdict, VERDICT.KEEP);
});
t('③ 블렌딩 < 보정목표×0.9 → 감액 (일반 -10%)', () => {
  const j = judge({ ...base, blended: 4.0 }, S); // 하단 4.95
  assert.strictEqual(j.verdict, VERDICT.DOWN);
  assert.strictEqual(j.recommendedBid, 900);
});
t('③-1 감액률 0 분류(신제품) → 유지-감액금지', () => {
  const j = judge({ ...base, blended: 1.0, rule: R['신제품'] }, S);
  assert.strictEqual(j.verdict, VERDICT.KEEP_NO_DOWN);
});
t('③-2 1주차 순위 > 하한(6위) → 유지-순위저하', () => {
  const j = judge({ ...base, blended: 1.0, rank1w: 6.5 }, S);
  assert.strictEqual(j.verdict, VERDICT.KEEP_RANK);
});
t('③-3 핵심소재 감액 상한 5% (일반 10% → 5%)', () => {
  const j = judge({ ...base, blended: 1.0, isCore: true }, S);
  assert.strictEqual(j.verdict, VERDICT.DOWN);
  assert.strictEqual(j.adjustRate, -0.05);
  assert.strictEqual(j.recommendedBid, 950);
});
t('④ 밴드 내 → 유지', () => {
  const j = judge({ ...base, blended: 5.5 }, S);
  assert.strictEqual(j.verdict, VERDICT.KEEP);
});
t('⑤ 최저입찰가 300원 하한', () => {
  const j = judge({ ...base, blended: 1.0, currentBid: 310, rule: R['비주력'] }, S); // -15% → 263.5 → 260 → min 300
  assert.strictEqual(j.recommendedBid, 300);
});
t('⑥ 10원 단위 반올림', () => {
  assert.strictEqual(roundBid10(994), 990);
  assert.strictEqual(roundBid10(995), 1000);
  const j = judge({ ...base, blended: 6.5, currentBid: 1050 }, S); // ×1.1=1155 → 1160
  assert.strictEqual(j.recommendedBid, 1160);
});
t('⑦ 분류계수 반영 (집중홍보 0.8 → 보정목표 4.4)', () => {
  const j = judge({ ...base, blended: 4.9, rule: R['집중홍보'] }, S); // 상단 4.84 → 증액
  assert.strictEqual(j.verdict, VERDICT.UP);
  assert.strictEqual(j.adjustedTarget.toFixed(2), '4.40');
});
t('⑧ 블렌딩 null(분모0) → 데이터부족', () => {
  const j = judge({ ...base, blended: null }, S);
  assert.strictEqual(j.verdict, VERDICT.NO_DATA);
});

console.log('── 제외 캠페인 ──');
t('기본값은 빈 목록 (브랜드별 목록은 계정 설정에 저장)', () => {
  assert.strictEqual(parseExcludedCampaigns(DEFAULT_SETTINGS.excluded_campaigns).length, 0);
});
t('멀티라인 목록 4건 파싱', () => {
  const pats = parseExcludedCampaigns('[이고진_카테고리] 키워드\n[이고진] 키워드\n#렌탈 벌크\n#전체 벌크');
  assert.strictEqual(pats.length, 4);
  assert.ok(pats.includes('[이고진] 키워드') && pats.includes('#렌탈 벌크'));
});
t('포함 일치로 제외 판별', () => {
  const pats = parseExcludedCampaigns('[이고진] 키워드\n#전체 벌크');
  assert.strictEqual(isExcludedCampaign('[이고진] 키워드', pats), true);
  assert.strictEqual(isExcludedCampaign('2024 #전체 벌크 캠페인', pats), true);
  assert.strictEqual(isExcludedCampaign('[00-1] 런닝머신 메인', pats), false);
});
t('빈 설정 → 아무것도 제외 안 함', () => {
  assert.strictEqual(isExcludedCampaign('아무 캠페인', parseExcludedCampaigns('')), false);
});

console.log('── 구글 시트 연동 파서 ──');
const sheetSync = require('../src/bidapp/sheetSync');
t('시트 주소 파싱 (id + gid)', () => {
  const p = sheetSync.parseSheetUrl('https://docs.google.com/spreadsheets/d/1IKIzZD_tiUgB6uYmKzxrj6XrMmeV5XVSoLVcQ5YE344/edit?gid=1523020966#gid=1523020966');
  assert.strictEqual(p.id, '1IKIzZD_tiUgB6uYmKzxrj6XrMmeV5XVSoLVcQ5YE344');
  assert.strictEqual(p.gid, '1523020966');
  assert.strictEqual(sheetSync.parseSheetUrl('https://example.com/x'), null);
});
t('CSV 파싱 (따옴표·쉼표·개행)', () => {
  const rows = sheetSync.parseCsv('소재ID,이름,"손익분기 ROAS"\nnad-1,"상품,A",550%\nnad-2,B,4.2');
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[1][1], '상품,A');
  assert.strictEqual(rows[2][2], '4.2');
});
t('손익분기 ROAS 값 인식: 550% / 550 / 5.5 → 5.5', () => {
  assert.strictEqual(sheetSync.parseRoas('550%'), 5.5);
  assert.strictEqual(sheetSync.parseRoas('550'), 5.5);
  assert.strictEqual(sheetSync.parseRoas('5.5'), 5.5);
  assert.strictEqual(sheetSync.parseRoas('3,000%'), 30);
  assert.strictEqual(sheetSync.parseRoas(''), null);
  assert.strictEqual(sheetSync.parseRoas('abc'), null);
});
t('헤더 열 탐색 (공백 무시 포함 일치)', () => {
  const h = ['소재 ID', '소재명', '캠페인', '월 매출', '운영 등급', '손익분기ROAS'];
  assert.strictEqual(sheetSync.findCol(h, '소재ID'), 0);
  assert.strictEqual(sheetSync.findCol(h, '손익분기ROAS'), 5);
  assert.strictEqual(sheetSync.findCol(h, '운영등급'), 4);
  assert.strictEqual(sheetSync.findCol(h, '없는열'), -1);
});

console.log('── 주차 유틸 ──');
t('mondayOf: 수요일 → 해당 주 월요일', () => {
  assert.strictEqual(mondayOf('2026-08-05'), '2026-08-03'); // 수 → 월
  assert.strictEqual(mondayOf('2026-08-09'), '2026-08-03'); // 일 → 월
});
t('last4Weeks: 최신 완료 주부터 역순 4개', () => {
  const w = last4Weeks('2026-08-05'); // 이번 주 월=8/3 → 1주차 7/27~8/2
  assert.strictEqual(w[0].start, '2026-07-27');
  assert.strictEqual(w[0].end, '2026-08-02');
  assert.strictEqual(w[3].start, '2026-07-06');
});

console.log(`\n${process.exitCode ? '❌ 실패 있음' : `✅ 전체 통과 (${passed}건)`}`);
