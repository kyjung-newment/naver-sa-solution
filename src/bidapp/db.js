// ─── 이고진 입찰관리: DB 스키마 + DAO ──────────────────────────────
// 기존 Supabase PostgreSQL pool 재사용. 테이블은 bid_ 접두사로 격리.
const { pool } = require('../db/database');
const { DEFAULT_SETTINGS, DEFAULT_CATEGORY_RULES, CATEGORIES } = require('./logic');

const get = async (sql, params = []) => (await pool.query(sql, params)).rows[0] || null;
const all = async (sql, params = []) => (await pool.query(sql, params)).rows;

// ─── 스키마 초기화 ─────────────────────────────────────────────────
async function initBidDb() {
  const safe = async (sql) => {
    try { await pool.query(sql); } catch (e) {
      if (e.message && e.message.includes('read-only')) return;
      throw e;
    }
  };

  // 소재 (쇼핑검색 소재 = nccAdId 단위)
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_materials (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      ncc_ad_id TEXT NOT NULL,
      ncc_adgroup_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      campaign_name TEXT NOT NULL DEFAULT '',
      adgroup_name TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '일반',
      target_roas REAL NOT NULL DEFAULT 5.5,
      enabled INTEGER NOT NULL DEFAULT 1,
      mode_override TEXT DEFAULT '',
      current_bid INTEGER NOT NULL DEFAULT 0,
      use_group_bid INTEGER NOT NULL DEFAULT 0,
      registered_at TEXT DEFAULT '',
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, ncc_ad_id)
    )
  `);

  // 주차별 성과 (주차 시작일 = 월요일)
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_weekly_stats (
      id SERIAL PRIMARY KEY,
      material_id INTEGER NOT NULL REFERENCES bid_materials(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      imp BIGINT DEFAULT 0,
      clk BIGINT DEFAULT 0,
      avg_rank REAL DEFAULT 0,
      avg_cpc INTEGER DEFAULT 0,
      cost BIGINT DEFAULT 0,
      revenue BIGINT DEFAULT 0,
      conv_cnt INTEGER DEFAULT 0,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(material_id, week_start)
    )
  `);

  // 설정 key-value (계정별)
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_settings (
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(account_id, key)
    )
  `);

  // 설정 변경 이력
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_setting_history (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      old_value TEXT DEFAULT '',
      new_value TEXT DEFAULT '',
      changed_by TEXT DEFAULT '',
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 분류별 규칙 (계정별)
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_category_rules (
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      coef REAL NOT NULL DEFAULT 1.0,
      up_rate REAL NOT NULL DEFAULT 0.10,
      down_rate REAL NOT NULL DEFAULT 0.10,
      PRIMARY KEY(account_id, category)
    )
  `);

  // 조정 내역
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_adjustments (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES bid_materials(id) ON DELETE CASCADE,
      week_start DATE NOT NULL,
      prev_bid INTEGER NOT NULL DEFAULT 0,
      calc_bid INTEGER NOT NULL DEFAULT 0,
      applied_bid INTEGER DEFAULT NULL,
      verdict TEXT NOT NULL DEFAULT '유지',
      adjust_rate REAL NOT NULL DEFAULT 0,
      blended_roas REAL DEFAULT NULL,
      adjusted_target REAL NOT NULL DEFAULT 0,
      is_core INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      note TEXT DEFAULT '',
      approved_by TEXT DEFAULT '',
      applied_at TIMESTAMP,
      api_response TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(material_id, week_start)
    )
  `);
  await safe(`CREATE INDEX IF NOT EXISTS ix_bid_adj_acct ON bid_adjustments (account_id, week_start)`);
  await safe(`CREATE INDEX IF NOT EXISTS ix_bid_adj_status ON bid_adjustments (account_id, status)`);

  // 감사 로그 (삭제 불가 — 앱에서 DELETE 미제공)
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_audit_log (
      id SERIAL PRIMARY KEY,
      account_id INTEGER,
      user_name TEXT DEFAULT '',
      action TEXT NOT NULL,
      detail TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 일간 모니터 알림
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_alerts (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES bid_materials(id) ON DELETE CASCADE,
      alert_date DATE NOT NULL,
      day_cost BIGINT DEFAULT 0,
      avg_cost BIGINT DEFAULT 0,
      day_roas REAL DEFAULT 0,
      target_roas REAL DEFAULT 0,
      resolved INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(material_id, alert_date)
    )
  `);

  // 월간 리포트
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_monthly_reports (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      month TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, month)
    )
  `);

  // 크론 중복 실행 방지
  await safe(`
    CREATE TABLE IF NOT EXISTS bid_cron_runs (
      run_key TEXT PRIMARY KEY,
      result TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('✅ 입찰관리 DB 초기화 완료');
}

// ─── 설정 ──────────────────────────────────────────────────────────
async function getSettings(accountId) {
  const rows = await all('SELECT key, value FROM bid_settings WHERE account_id = $1', [accountId]);
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (!(r.key in s)) { s[r.key] = r.value; continue; }
    s[r.key] = (typeof DEFAULT_SETTINGS[r.key] === 'number') ? parseFloat(r.value) : r.value;
  }
  return s;
}

async function setSetting(accountId, key, value, changedBy = '') {
  const old = await get('SELECT value FROM bid_settings WHERE account_id = $1 AND key = $2', [accountId, key]);
  const oldVal = old ? old.value : String(DEFAULT_SETTINGS[key] ?? '');
  if (String(value) === oldVal) return false;
  await pool.query(`
    INSERT INTO bid_settings (account_id, key, value, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (account_id, key) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP
  `, [accountId, key, String(value)]);
  await pool.query(
    'INSERT INTO bid_setting_history (account_id, key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
    [accountId, key, oldVal, String(value), changedBy]
  );
  return true;
}

async function getSettingHistory(accountId, limit = 100) {
  return all('SELECT * FROM bid_setting_history WHERE account_id = $1 ORDER BY changed_at DESC LIMIT $2', [accountId, limit]);
}

// ─── 분류 규칙 ─────────────────────────────────────────────────────
async function getCategoryRules(accountId) {
  const rows = await all('SELECT * FROM bid_category_rules WHERE account_id = $1', [accountId]);
  const rules = {};
  for (const c of CATEGORIES) rules[c] = { ...DEFAULT_CATEGORY_RULES[c] };
  for (const r of rows) rules[r.category] = { coef: r.coef, up: r.up_rate, down: r.down_rate };
  return rules;
}

async function setCategoryRule(accountId, category, { coef, up, down }, changedBy = '') {
  await pool.query(`
    INSERT INTO bid_category_rules (account_id, category, coef, up_rate, down_rate) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (account_id, category) DO UPDATE SET coef = $3, up_rate = $4, down_rate = $5
  `, [accountId, category, coef, up, down]);
  await pool.query(
    'INSERT INTO bid_setting_history (account_id, key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
    [accountId, `분류규칙:${category}`, '', `계수 ${coef} / 증액 ${Math.round(up * 100)}% / 감액 ${Math.round(down * 100)}%`, changedBy]
  );
}

// ─── 소재 ──────────────────────────────────────────────────────────
async function getMaterials(accountId, { enabledOnly = false } = {}) {
  return all(
    `SELECT * FROM bid_materials WHERE account_id = $1 ${enabledOnly ? 'AND enabled = 1' : ''} ORDER BY campaign_name, adgroup_name, name`,
    [accountId]
  );
}

async function getMaterialById(id, accountId) {
  return get('SELECT * FROM bid_materials WHERE id = $1 AND account_id = $2', [id, accountId]);
}

async function upsertMaterial(accountId, m) {
  const r = await pool.query(`
    INSERT INTO bid_materials (account_id, ncc_ad_id, ncc_adgroup_id, name, campaign_name, adgroup_name, current_bid, use_group_bid, registered_at, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
    ON CONFLICT (account_id, ncc_ad_id) DO UPDATE SET
      ncc_adgroup_id = $3, name = $4, campaign_name = $5, adgroup_name = $6,
      current_bid = $7, use_group_bid = $8, synced_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [accountId, m.nccAdId, m.nccAdgroupId || '', m.name || '', m.campaignName || '', m.adgroupName || '',
      m.currentBid || 0, m.useGroupBid ? 1 : 0, m.registeredAt || '']);
  return r.rows[0].id;
}

async function updateMaterialMeta(id, accountId, { category, target_roas, enabled, mode_override }) {
  return pool.query(`
    UPDATE bid_materials SET
      category = COALESCE($3, category),
      target_roas = COALESCE($4, target_roas),
      enabled = COALESCE($5, enabled),
      mode_override = COALESCE($6, mode_override)
    WHERE id = $1 AND account_id = $2
  `, [id, accountId, category ?? null, target_roas ?? null, enabled ?? null, mode_override ?? null]);
}

async function setMaterialBid(id, bid) {
  return pool.query('UPDATE bid_materials SET current_bid = $2 WHERE id = $1', [id, bid]);
}

// ─── 주차별 성과 ───────────────────────────────────────────────────
async function upsertWeeklyStat(materialId, weekStart, s) {
  return pool.query(`
    INSERT INTO bid_weekly_stats (material_id, week_start, imp, clk, avg_rank, avg_cpc, cost, revenue, conv_cnt, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
    ON CONFLICT (material_id, week_start) DO UPDATE SET
      imp = $3, clk = $4, avg_rank = $5, avg_cpc = $6, cost = $7, revenue = $8, conv_cnt = $9, synced_at = CURRENT_TIMESTAMP
  `, [materialId, weekStart, s.imp || 0, s.clk || 0, s.avgRank || 0, s.avgCpc || 0, s.cost || 0, s.revenue || 0, s.convCnt || 0]);
}

// 소재별 주차 데이터 맵: { materialId: { weekStart: row } }
async function getWeeklyStatsMap(accountId, weekStarts) {
  const rows = await all(`
    SELECT ws.* FROM bid_weekly_stats ws
    JOIN bid_materials m ON m.id = ws.material_id
    WHERE m.account_id = $1 AND ws.week_start = ANY($2::date[])
  `, [accountId, weekStarts]);
  const map = {};
  for (const r of rows) {
    const wk = (r.week_start instanceof Date) ? r.week_start.toISOString().slice(0, 10) : String(r.week_start).slice(0, 10);
    if (!map[r.material_id]) map[r.material_id] = {};
    map[r.material_id][wk] = r;
  }
  return map;
}

// ─── 조정 내역 ─────────────────────────────────────────────────────
async function upsertAdjustment(a) {
  const r = await pool.query(`
    INSERT INTO bid_adjustments (account_id, material_id, week_start, prev_bid, calc_bid, verdict, adjust_rate, blended_roas, adjusted_target, is_core, status, note)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    ON CONFLICT (material_id, week_start) DO UPDATE SET
      prev_bid = $4, calc_bid = $5, verdict = $6, adjust_rate = $7, blended_roas = $8,
      adjusted_target = $9, is_core = $10,
      -- 이미 적용/승인된 건은 재계산으로 덮지 않음
      status = CASE WHEN bid_adjustments.status IN ('applied','auto_applied','approved') THEN bid_adjustments.status ELSE $11 END,
      note = $12, created_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [a.accountId, a.materialId, a.weekStart, a.prevBid, a.calcBid, a.verdict, a.adjustRate,
      a.blendedRoas, a.adjustedTarget, a.isCore ? 1 : 0, a.status || 'pending', a.note || '']);
  return r.rows[0].id;
}

async function getAdjustmentById(id, accountId) {
  return get(`
    SELECT a.*, m.name AS material_name, m.ncc_ad_id, m.campaign_name, m.adgroup_name, m.category, m.current_bid
    FROM bid_adjustments a JOIN bid_materials m ON m.id = a.material_id
    WHERE a.id = $1 AND a.account_id = $2
  `, [id, accountId]);
}

async function getAdjustments(accountId, { weekStart, status, limit = 500 } = {}) {
  const conds = ['a.account_id = $1'];
  const params = [accountId];
  if (weekStart) { params.push(weekStart); conds.push(`a.week_start = $${params.length}`); }
  if (status) { params.push(status); conds.push(`a.status = $${params.length}`); }
  params.push(limit);
  return all(`
    SELECT a.*, m.name AS material_name, m.ncc_ad_id, m.campaign_name, m.adgroup_name, m.category
    FROM bid_adjustments a JOIN bid_materials m ON m.id = a.material_id
    WHERE ${conds.join(' AND ')}
    ORDER BY a.week_start DESC, m.campaign_name, m.name
    LIMIT $${params.length}
  `, params);
}

async function setAdjustmentStatus(id, accountId, { status, approvedBy, appliedBid, apiResponse }) {
  return pool.query(`
    UPDATE bid_adjustments SET
      status = $3,
      approved_by = COALESCE($4, approved_by),
      applied_bid = COALESCE($5, applied_bid),
      api_response = COALESCE($6, api_response),
      applied_at = CASE WHEN $3 IN ('applied','auto_applied') THEN CURRENT_TIMESTAMP ELSE applied_at END
    WHERE id = $1 AND account_id = $2
  `, [id, accountId, status, approvedBy ?? null, appliedBid ?? null, apiResponse ?? null]);
}

// ─── 감사 로그 ─────────────────────────────────────────────────────
async function audit(accountId, userName, action, detail = '') {
  try {
    await pool.query(
      'INSERT INTO bid_audit_log (account_id, user_name, action, detail) VALUES ($1, $2, $3, $4)',
      [accountId || null, userName || '', action, typeof detail === 'string' ? detail : JSON.stringify(detail)]
    );
  } catch (e) { console.log('감사로그 기록 실패:', e.message); }
}

async function getAuditLog(accountId, limit = 200) {
  return all('SELECT * FROM bid_audit_log WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2', [accountId, limit]);
}

// ─── 알림 ──────────────────────────────────────────────────────────
async function upsertAlert(accountId, materialId, alertDate, data) {
  return pool.query(`
    INSERT INTO bid_alerts (account_id, material_id, alert_date, day_cost, avg_cost, day_roas, target_roas)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (material_id, alert_date) DO UPDATE SET
      day_cost = $4, avg_cost = $5, day_roas = $6, target_roas = $7
  `, [accountId, materialId, alertDate, data.dayCost || 0, data.avgCost || 0, data.dayRoas || 0, data.targetRoas || 0]);
}

async function getAlerts(accountId, { unresolvedOnly = true, limit = 100 } = {}) {
  return all(`
    SELECT al.*, m.name AS material_name, m.campaign_name, m.adgroup_name, m.current_bid, m.category
    FROM bid_alerts al JOIN bid_materials m ON m.id = al.material_id
    WHERE al.account_id = $1 ${unresolvedOnly ? 'AND al.resolved = 0' : ''}
    ORDER BY al.alert_date DESC, al.day_cost DESC LIMIT $2
  `, [accountId, limit]);
}

async function resolveAlert(id, accountId) {
  return pool.query('UPDATE bid_alerts SET resolved = 1 WHERE id = $1 AND account_id = $2', [id, accountId]);
}

// ─── 월간 리포트 ───────────────────────────────────────────────────
async function saveMonthlyReport(accountId, month, payload) {
  return pool.query(`
    INSERT INTO bid_monthly_reports (account_id, month, payload) VALUES ($1, $2, $3)
    ON CONFLICT (account_id, month) DO UPDATE SET payload = $3, created_at = CURRENT_TIMESTAMP
  `, [accountId, month, JSON.stringify(payload)]);
}

async function getMonthlyReports(accountId, limit = 12) {
  return all('SELECT * FROM bid_monthly_reports WHERE account_id = $1 ORDER BY month DESC LIMIT $2', [accountId, limit]);
}

// ─── 크론 중복 방지 ────────────────────────────────────────────────
async function tryClaimCronRun(runKey, result = '') {
  try {
    await pool.query('INSERT INTO bid_cron_runs (run_key, result) VALUES ($1, $2)', [runKey, result]);
    return true;
  } catch (e) {
    return false; // 이미 실행됨
  }
}

module.exports = {
  pool, initBidDb,
  getSettings, setSetting, getSettingHistory,
  getCategoryRules, setCategoryRule,
  getMaterials, getMaterialById, upsertMaterial, updateMaterialMeta, setMaterialBid,
  upsertWeeklyStat, getWeeklyStatsMap,
  upsertAdjustment, getAdjustmentById, getAdjustments, setAdjustmentStatus,
  audit, getAuditLog,
  upsertAlert, getAlerts, resolveAlert,
  saveMonthlyReport, getMonthlyReports,
  tryClaimCronRun,
};
