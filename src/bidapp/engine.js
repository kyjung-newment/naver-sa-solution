// ─── 이고진 입찰관리: 조정 엔진 ─────────────────────────────────────
// 주간 계산(수집→판정→조정안 생성→모드별 자동적용/승인요청), 적용(안전장치 포함),
// 일간 모니터, 월간 리포트 생성.
const bidDb = require('./db');
const logic = require('./logic');
const collector = require('./collector');

const wkKey = (w) => (w instanceof Date) ? w.toISOString().slice(0, 10) : String(w).slice(0, 10);

/**
 * 주간 계산: 4주 성과 기반 판정 → bid_adjustments upsert
 * @returns {{weekStart, rows: [...]}} 계산 결과 (미리보기 데이터와 동일)
 */
async function computeWeekly(account, { save = true, base = null } = {}) {
  if (base) save = false; // 과거 주간 조회는 조정안을 덮어쓰지 않음
  const settings = await bidDb.getSettings(account.id);
  const rules = await bidDb.getCategoryRules(account.id);
  const weeks = logic.last4Weeks(base);
  const weekStarts = weeks.map(w => w.start);
  const materials = await bidDb.getMaterials(account.id, { enabledOnly: true });
  const statsMap = await bidDb.getWeeklyStatsMap(account.id, weekStarts);

  // 4주 누적 매출 → 핵심소재 (+수동 오버라이드: core_override '1'=핵심 고정, '0'=제외 고정)
  const items = materials.map(m => {
    const ws = statsMap[m.id] || {};
    const revenue4w = weekStarts.reduce((a, k) => a + parseInt(ws[k]?.revenue || 0), 0);
    return { id: m.id, revenue4w };
  });
  const coreSet = logic.coreMaterialIds(items, settings.core_share);
  for (const m of materials) {
    if (m.core_override === '1') coreSet.add(m.id);
    else if (m.core_override === '0') coreSet.delete(m.id);
  }

  const rows = [];
  for (const m of materials) {
    const ws = statsMap[m.id] || {};
    const weekData = weekStarts.map(k => ({
      cost: parseInt(ws[k]?.cost || 0),
      revenue: parseInt(ws[k]?.revenue || 0),
      rank: parseFloat(ws[k]?.avg_rank || 0),
    }));
    const cost4w = weekData.reduce((a, w) => a + w.cost, 0);
    const revenue4w = weekData.reduce((a, w) => a + w.revenue, 0);
    const blended = logic.blendedRoas(weekData, settings);
    const rule = rules[m.category] || rules['일반'];
    const isCore = coreSet.has(m.id);
    const currentBid = m.current_bid || 0;

    const j = logic.judge({
      blended,
      targetRoas: m.target_roas || settings.default_target_roas,
      rule,
      cost4w,
      rank1w: weekData[0].rank,
      isCore,
      currentBid,
    }, settings);

    // 매출볼륨 감액 보류 (후처리): 감액 판정 + 기준매출 대비 최신주 매출 하락 → 승인 대기 강제
    const baseline = m.baseline_weekly_revenue == null ? null : parseInt(m.baseline_weekly_revenue);
    const verdict = logic.volumeHold(j.verdict, weekData[0].revenue, baseline, settings);
    let note = '';
    if (verdict === logic.VERDICT.DOWN_HOLD) {
      const dropPct = baseline > 0 ? ((1 - weekData[0].revenue / baseline) * 100).toFixed(1) : '-';
      note = `기준매출 ${baseline.toLocaleString('ko-KR')}원 · 최신주 ${weekData[0].revenue.toLocaleString('ko-KR')}원 (▼${dropPct}%) — 볼륨하락 감액보류`;
    }

    const row = {
      materialId: m.id, material: m,
      weekStart: weekStarts[0],
      prevBid: currentBid, calcBid: j.recommendedBid,
      verdict, adjustRate: j.adjustRate,
      blendedRoas: blended, adjustedTarget: j.adjustedTarget,
      isCore, cost4w, revenue4w, weekData, note,
      baselineWeeklyRevenue: baseline,
    };
    rows.push(row);

    if (save && currentBid > 0) {
      await bidDb.upsertAdjustment({
        accountId: account.id, materialId: m.id, weekStart: weekStarts[0],
        prevBid: currentBid, calcBid: j.recommendedBid,
        verdict, adjustRate: j.adjustRate,
        blendedRoas: blended, adjustedTarget: j.adjustedTarget, isCore,
        status: (verdict === logic.VERDICT.UP || verdict === logic.VERDICT.DOWN) ? 'pending'
          : verdict === logic.VERDICT.DOWN_HOLD ? 'hold_volume' : 'skipped',
        note,
      });
    }
  }
  return { weekStart: weekStarts[0], weeks, rows, settings };
}

/**
 * 조정 1건 적용 (안전장치 전체 포함)
 * - 적용 전 현재 입찰가 API 재조회 → DB값과 다르면 경고 note 기록
 * - ±force_approval_delta 초과는 approve 경로가 아닌 자동 적용에서 차단
 * - 성공: applied/auto_applied, 실패: failed + 응답 기록. 모든 결과 AuditLog.
 */
async function applyAdjustment(account, creds, adjId, { auto = false, actor = 'system' } = {}) {
  const adj = await bidDb.getAdjustmentById(adjId, account.id);
  if (!adj) return { ok: false, error: '조정 내역 없음' };
  if (['applied', 'auto_applied'].includes(adj.status)) return { ok: false, error: '이미 적용됨' };
  if (adj.calc_bid === adj.prev_bid) {
    await bidDb.setAdjustmentStatus(adjId, account.id, { status: 'skipped', apiResponse: '변경 없음' });
    return { ok: true, skipped: true };
  }

  let note = '';
  try {
    // 안전장치: 적용 전 현재 입찰가 재조회
    const live = await collector.fetchLiveBid(account, creds, adj.ncc_ad_id);
    if (live.bid && live.bid !== adj.prev_bid) {
      note = `경고: 적용 시점 실제 입찰가 ${live.bid}원 ≠ 계산 기준 ${adj.prev_bid}원`;
      console.log(`  ⚠️ [${adj.material_name}] ${note}`);
    }
    await collector.applyBid(account, creds, adj.ncc_ad_id, adj.calc_bid);
    await bidDb.setAdjustmentStatus(adjId, account.id, {
      status: auto ? 'auto_applied' : 'applied',
      approvedBy: actor,
      appliedBid: adj.calc_bid,
      apiResponse: JSON.stringify({ ok: true, note, liveBid: live.bid, at: new Date().toISOString() }),
    });
    await bidDb.setMaterialBid(adj.material_id, adj.calc_bid);
    await bidDb.audit(account.id, actor, auto ? '입찰가 자동적용' : '입찰가 적용', {
      material: adj.material_name, nccAdId: adj.ncc_ad_id,
      from: adj.prev_bid, to: adj.calc_bid, verdict: adj.verdict, note,
    });
    return { ok: true, note };
  } catch (e) {
    await bidDb.setAdjustmentStatus(adjId, account.id, {
      status: 'failed',
      apiResponse: JSON.stringify({ ok: false, error: e.message, note }),
    });
    await bidDb.audit(account.id, actor, '입찰가 적용 실패', {
      material: adj.material_name, nccAdId: adj.ncc_ad_id, from: adj.prev_bid, to: adj.calc_bid, error: e.message,
    });
    return { ok: false, error: e.message };
  }
}

/**
 * 주간 실행 (크론/수동): 수집 → 계산 → 모드별 처리
 * auto 모드: |조정률| ≤ force_approval_delta 인 건만 자동 적용, 초과분은 승인 대기.
 * approval 모드: 전부 승인 대기. 소재별 mode_override 우선.
 */
async function runWeekly(account, creds, { actor = 'cron' } = {}) {
  await collector.syncMaterials(account, creds);
  const stats = await collector.collectWeeklyStats(account, creds);
  const { weekStart, rows, settings } = await computeWeekly(account, { save: true });

  let applied = 0, pending = 0, failed = 0;
  // hold_volume(감액보류)은 auto 모드여도 자동 적용 대상에서 제외 — 승인함에서만 처리
  const adjustables = await bidDb.getAdjustments(account.id, { weekStart, status: 'pending' });
  for (const adj of adjustables) {
    const m = await bidDb.getMaterialById(adj.material_id, account.id);
    const mode = (m?.mode_override === 'auto' || m?.mode_override === 'approval') ? m.mode_override : settings.adjust_mode;
    const deltaRate = adj.prev_bid > 0 ? Math.abs(adj.calc_bid - adj.prev_bid) / adj.prev_bid : 0;
    if (mode === 'auto' && deltaRate <= settings.force_approval_delta) {
      const r = await applyAdjustment(account, creds, adj.id, { auto: true, actor });
      if (r.ok && !r.skipped) applied++;
      else if (!r.ok) failed++;
    } else {
      pending++; // 승인 대기 유지 (auto 모드여도 ±20% 초과는 무조건 승인)
    }
  }
  const held = (await bidDb.getAdjustments(account.id, { weekStart, status: 'hold_volume' })).length;
  pending += held;
  await bidDb.audit(account.id, actor, '주간 조정 실행', {
    weekStart, materials: stats.materials, statOk: stats.ok, statFail: stats.fail, applied, pending, held, failed,
  });
  return { weekStart, materials: stats.materials, applied, pending, held, failed, rows: rows.length };
}

/**
 * 일간 모니터 (자동 조정 없음 — 알림만):
 * 일 비용 > 4주 일평균 × daily_cost_mult AND 당일 ROAS < 보정목표 × daily_roas_mult
 */
async function runDailyMonitor(account, creds, dateStr) {
  const settings = await bidDb.getSettings(account.id);
  const rules = await bidDb.getCategoryRules(account.id);
  const weeks = logic.last4Weeks();
  const statsMap = await bidDb.getWeeklyStatsMap(account.id, weeks.map(w => w.start));
  const daily = await collector.collectDailyStats(account, creds, dateStr);

  let alerts = 0;
  for (const { material: m, cost, revenue } of daily) {
    if (!cost) continue;
    const ws = statsMap[m.id] || {};
    const cost4w = weeks.reduce((a, w) => a + parseInt(ws[w.start]?.cost || 0), 0);
    const avgDaily = cost4w / 28;
    if (avgDaily <= 0) continue;
    const rule = rules[m.category] || rules['일반'];
    const adjustedTarget = (m.target_roas || settings.default_target_roas) * rule.coef;
    const dayRoas = cost > 0 ? revenue / cost : 0;
    if (cost > avgDaily * settings.daily_cost_mult && dayRoas < adjustedTarget * settings.daily_roas_mult) {
      await bidDb.upsertAlert(account.id, m.id, dateStr, {
        dayCost: cost, avgCost: Math.round(avgDaily), dayRoas, targetRoas: adjustedTarget,
      });
      alerts++;
    }
  }
  await bidDb.audit(account.id, 'cron', '일간 모니터 실행', { date: dateStr, checked: daily.length, alerts });
  return { checked: daily.length, alerts };
}

/**
 * 기준매출 산출 (매월 1일 크론 + 설정 화면 수동 실행):
 * 소재별 전월(달력 기준) 매출 합계 ÷ 전월 일수 × 7 → 주간 환산, 100원 단위 반올림.
 * 전월 데이터가 전무한 신규 소재는 null (볼륨 보류 조건 미적용).
 * @param {string} month 'YYYY-MM' (전월)
 */
async function computeBaselines(account, creds, month, { actor = 'cron' } = {}) {
  const [y, mo] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const since = `${month}-01`;
  const until = `${month}-${String(daysInMonth).padStart(2, '0')}`;
  const collected = await collector.collectMonthlyRevenue(account, creds, since, until);
  let updated = 0, nulled = 0;
  for (const { material: m, revenue, hasData } of collected) {
    const baseline = hasData ? logic.calcBaselineWeekly(revenue, daysInMonth) : null;
    await bidDb.setMaterialBaseline(m.id, account.id, baseline, { materialName: m.name, changedBy: actor });
    if (baseline == null) nulled++; else updated++;
  }
  await bidDb.audit(account.id, actor, '기준매출 산출', { month, since, until, updated, noData: nulled });
  return { month, updated, noData: nulled };
}

/**
 * 월간 리포트: 4주 연속 감액/증액 소재 + 목표ROAS 재검토 대상
 */
async function runMonthlyReport(account, month) {
  const materials = await bidDb.getMaterials(account.id);
  const byMat = {};
  const recent = await bidDb.getAdjustments(account.id, { limit: 5000 });
  for (const a of recent) {
    if (!byMat[a.material_id]) byMat[a.material_id] = [];
    byMat[a.material_id].push(a);
  }
  const consecUp = [], consecDown = [], reviewTargets = [];
  for (const m of materials) {
    const list = (byMat[m.id] || []).sort((a, b) => wkKey(b.week_start).localeCompare(wkKey(a.week_start))).slice(0, 4);
    if (list.length < 4) continue;
    const verdicts = list.map(a => a.verdict);
    const entry = { id: m.id, name: m.name, category: m.category, target_roas: m.target_roas, verdicts };
    if (verdicts.every(v => v === logic.VERDICT.UP)) { consecUp.push(entry); reviewTargets.push({ ...entry, reason: '4주 연속 증액 — 목표ROAS 상향 검토' }); }
    if (verdicts.every(v => v === logic.VERDICT.DOWN)) { consecDown.push(entry); reviewTargets.push({ ...entry, reason: '4주 연속 감액 — 목표ROAS 하향 또는 소재 재검토' }); }
  }
  const payload = { month, consecUp, consecDown, reviewTargets, generatedAt: new Date().toISOString() };
  await bidDb.saveMonthlyReport(account.id, month, payload);
  await bidDb.audit(account.id, 'cron', '월간 리포트 생성', { month, up: consecUp.length, down: consecDown.length });
  return payload;
}

/**
 * 수동 조정 (일간 트리거 ±3%, 월간 ±15% 등): 즉시 조정안 생성 후 승인 대기
 */
async function createManualAdjustment(account, materialId, rate, { actor = '', note = '' } = {}) {
  const settings = await bidDb.getSettings(account.id);
  const m = await bidDb.getMaterialById(materialId, account.id);
  if (!m || !m.current_bid) return { ok: false, error: '소재 또는 현재 입찰가 없음' };
  const calcBid = Math.max(logic.roundBid10(m.current_bid * (1 + rate)), settings.min_bid);
  const weekStart = logic.last4Weeks()[0].start;
  const id = await bidDb.upsertAdjustment({
    accountId: account.id, materialId, weekStart,
    prevBid: m.current_bid, calcBid,
    verdict: rate > 0 ? logic.VERDICT.UP : logic.VERDICT.DOWN, adjustRate: rate,
    blendedRoas: null, adjustedTarget: 0, isCore: false,
    status: 'pending', note: note || `수동 조정 ${rate > 0 ? '+' : ''}${Math.round(rate * 100)}%`,
  });
  await bidDb.audit(account.id, actor, '수동 조정 생성', { material: m.name, rate, calcBid });
  return { ok: true, id, calcBid };
}

module.exports = { computeWeekly, applyAdjustment, runWeekly, runDailyMonitor, runMonthlyReport, computeBaselines, createManualAdjustment };
