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

  // v2: 기준매출(지난달 주간평균, 100원 단위) — null = 전월 데이터 없는 신규 소재
  await safe(`ALTER TABLE bid_materials ADD COLUMN IF NOT EXISTS baseline_weekly_revenue BIGINT DEFAULT NULL`);
  // v2.1: 핵심소재 수동 오버라이드 ('' 자동판별 / '1' 핵심 고정 / '0' 제외 고정)
  await safe(`ALTER TABLE bid_materials ADD COLUMN IF NOT EXISTS core_override TEXT NOT NULL DEFAULT ''`);
  // v2.3: 자동 비활성(동기화에서 미발견/유형 제외) 을 수동 제외(enabled)와 분리
  await safe(`ALTER TABLE bid_materials ADD COLUMN IF NOT EXISTS auto_disabled INTEGER NOT NULL DEFAULT 0`);
  // v2.5: 주차별 입찰가 스냅샷 — week_bid=해당 주 입찰가, bid_change_from=그 주 변경이 감지된 경우 변경 전 값
  // (솔루션 적용 시 즉시 기록 + 매주 월요일 동기화 때 광고시스템 외부 변경 감지)
  await safe(`ALTER TABLE bid_weekly_stats ADD COLUMN IF NOT EXISTS week_bid INTEGER DEFAULT NULL`);
  await safe(`ALTER TABLE bid_weekly_stats ADD COLUMN IF NOT EXISTS bid_change_from INTEGER DEFAULT NULL`);
  // v3: 채널 분리 — shopping(쇼핑검색 소재=nccAdId) / powerlink(파워링크 키워드=nccKeywordId)
  // 파워링크는 ncc_ad_id 컬럼에 키워드ID를 저장한다 (엔티티 ID로서 /stats·입찰 API에 동일하게 사용)
  await safe(`ALTER TABLE bid_materials ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'shopping'`);
  await safe(`ALTER TABLE bid_category_rules ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'shopping'`);
  // PK 재구성은 이미 (account_id, category, channel)이면 스킵 — 콜드스타트마다 배타 잠금 DDL 반복 방지
  try {
    const pk = await pool.query(`
      SELECT array_agg(a.attname ORDER BY x.n) AS cols
      FROM pg_constraint c
      JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS x(attnum, n) ON true
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
      WHERE c.conrelid = 'bid_category_rules'::regclass AND c.contype = 'p'
      GROUP BY c.oid
    `);
    const cols = (pk.rows[0] && pk.rows[0].cols) ? pk.rows[0].cols.join(',') : '';
    if (cols !== 'account_id,category,channel') {
      await safe(`ALTER TABLE bid_category_rules DROP CONSTRAINT IF EXISTS bid_category_rules_pkey`);
      await safe(`ALTER TABLE bid_category_rules ADD PRIMARY KEY (account_id, category, channel)`);
    }
  } catch (e) { console.log('bid_category_rules PK 확인 실패:', e.message); }
  await safe(`CREATE INDEX IF NOT EXISTS ix_bid_materials_channel ON bid_materials (account_id, channel)`);
  // v2: 초대 역할 (master=마스터 / client=광고주) — 기존 열람자는 광고주로 유지
  await safe(`ALTER TABLE account_viewers ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'client'`);
  // v2: 블렌딩 3구간(w1/w2/w3) → 2구간(blend_recent_weight, N=40 이관). 멱등.
  await safe(`
    INSERT INTO bid_settings (account_id, key, value)
    SELECT DISTINCT account_id, 'blend_recent_weight', '40' FROM bid_settings WHERE key IN ('w1','w2','w3')
    ON CONFLICT (account_id, key) DO NOTHING
  `);
  await safe(`DELETE FROM bid_settings WHERE key IN ('w1','w2','w3')`);

  // v2.6 일회성: 이고진 전용 기본 제외 캠페인 4건을 계정 설정으로 이관
  // (DEFAULT_SETTINGS.excluded_campaigns가 빈 값이 되면서 — 멀티 브랜드화 — 기존 동작 유지용)
  try {
    if (await tryClaimCronRun('migrate:egojin-excluded-campaigns-v2.6')) {
      const val = '[이고진_카테고리] 키워드\n[이고진] 키워드\n#렌탈 벌크\n#전체 벌크';
      const r = await pool.query(`
        INSERT INTO bid_settings (account_id, key, value)
        SELECT a.id, 'excluded_campaigns', $1 FROM ad_accounts a
        WHERE a.customer_id = '242566'
          AND NOT EXISTS (SELECT 1 FROM bid_settings s WHERE s.account_id = a.id AND s.key = 'excluded_campaigns')
      `, [val]);
      console.log(`✅ 이고진 제외 캠페인 기본값 이관: ${r.rowCount}건`);
    }
  } catch (e) { console.log('제외 캠페인 이관 마이그레이션 실패:', e.message); }

  // v2.3 일회성 복구: 엄격 유형 필터 버그로 전체 소재가 enabled=0 처리된 것을 복구.
  // 수동 제외 여부를 구분할 수 없으므로 enabled=1 + auto_disabled=1 로 되돌리고,
  // 다음 동기화에서 실제 발견되는(상품형) 소재만 auto_disabled=0 으로 활성화된다.
  try {
    if (await tryClaimCronRun('migrate:restore-auto-disabled-v2.3')) {
      const r = await pool.query(`UPDATE bid_materials SET enabled = 1, auto_disabled = 1 WHERE enabled = 0`);
      console.log(`✅ 소재 활성 상태 복구(자동 비활성으로 이관): ${r.rowCount}건`);
    }
  } catch (e) { console.log('소재 상태 복구 마이그레이션 실패:', e.message); }

  // v2.2 일회성: 매출 지표 변경(총전환매출→구매전환매출)으로 구 기준 승인대기 전체 반려.
  // bid_cron_runs 클레임으로 정확히 1회만 실행.
  try {
    if (await tryClaimCronRun('migrate:reject-stale-pendings-v2.2')) {
      const r = await pool.query(`
        UPDATE bid_adjustments
        SET status = 'rejected', approved_by = 'system (구매전환매출 기준 변경 — 구 기준 일괄 반려)'
        WHERE status IN ('pending', 'hold_volume')
      `);
      if (r.rowCount > 0) {
        await pool.query(
          `INSERT INTO bid_audit_log (account_id, user_name, action, detail)
           SELECT DISTINCT account_id, 'system', '승인대기 일괄 반려', $1 FROM bid_adjustments WHERE status = 'rejected'`,
          [JSON.stringify({ reason: '매출 지표 총전환매출→구매전환매출 변경으로 구 기준 조정안 무효화', rejected: r.rowCount })]
        );
      }
      console.log(`✅ 구 기준 승인대기 일괄 반려: ${r.rowCount}건`);
    }
  } catch (e) { console.log('승인대기 일괄 반려 마이그레이션 실패:', e.message); }

  console.log('✅ 입찰관리 DB 초기화 완료');
}

// ─── 설정 ──────────────────────────────────────────────────────────
// 채널 분리: shopping = 접두사 없는 키(기존 호환) / powerlink = 'pl_' 접두사 키
const chKey = (key, channel) => (channel === 'powerlink' ? 'pl_' + key : key);

async function getSettings(accountId, channel = 'shopping') {
  const rows = await all('SELECT key, value FROM bid_settings WHERE account_id = $1', [accountId]);
  const s = { ...DEFAULT_SETTINGS };
  const isPl = channel === 'powerlink';
  for (const r of rows) {
    if (isPl !== r.key.startsWith('pl_')) continue; // 채널 불일치 키 무시
    const k = isPl ? r.key.slice(3) : r.key;
    if (!(k in s)) { s[k] = r.value; continue; }
    s[k] = (typeof DEFAULT_SETTINGS[k] === 'number') ? parseFloat(r.value) : r.value;
  }
  return s;
}

async function setSetting(accountId, key, value, changedBy = '', channel = 'shopping') {
  const storeKey = chKey(key, channel);
  const old = await get('SELECT value FROM bid_settings WHERE account_id = $1 AND key = $2', [accountId, storeKey]);
  const oldVal = old ? old.value : String(DEFAULT_SETTINGS[key] ?? '');
  if (String(value) === oldVal) return false;
  await pool.query(`
    INSERT INTO bid_settings (account_id, key, value, updated_at) VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
    ON CONFLICT (account_id, key) DO UPDATE SET value = $3, updated_at = CURRENT_TIMESTAMP
  `, [accountId, storeKey, String(value)]);
  await pool.query(
    'INSERT INTO bid_setting_history (account_id, key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
    [accountId, storeKey, oldVal, String(value), changedBy]
  );
  return true;
}

async function getSettingHistory(accountId, limit = 100, channel = 'shopping') {
  const cond = channel === 'powerlink' ? "AND key LIKE 'pl\\_%'" : "AND key NOT LIKE 'pl\\_%'";
  return all(`SELECT * FROM bid_setting_history WHERE account_id = $1 ${cond} ORDER BY changed_at DESC LIMIT $2`, [accountId, limit]);
}

// ─── 분류 규칙 ─────────────────────────────────────────────────────
async function getCategoryRules(accountId, channel = 'shopping') {
  const rows = await all('SELECT * FROM bid_category_rules WHERE account_id = $1 AND channel = $2', [accountId, channel]);
  const rules = {};
  for (const c of CATEGORIES) rules[c] = { ...DEFAULT_CATEGORY_RULES[c] };
  for (const r of rows) rules[r.category] = { coef: r.coef, up: r.up_rate, down: r.down_rate };
  return rules;
}

async function setCategoryRule(accountId, category, { coef, up, down }, changedBy = '', channel = 'shopping') {
  await pool.query(`
    INSERT INTO bid_category_rules (account_id, category, channel, coef, up_rate, down_rate) VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (account_id, category, channel) DO UPDATE SET coef = $4, up_rate = $5, down_rate = $6
  `, [accountId, category, channel, coef, up, down]);
  await pool.query(
    'INSERT INTO bid_setting_history (account_id, key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
    [accountId, chKey(`분류규칙:${category}`, channel), '', `계수 ${coef} / 증액 ${Math.round(up * 100)}% / 감액 ${Math.round(down * 100)}%`, changedBy]
  );
}

// ─── 소재 ──────────────────────────────────────────────────────────
async function getMaterials(accountId, { enabledOnly = false, channel = 'shopping' } = {}) {
  return all(
    `SELECT * FROM bid_materials WHERE account_id = $1 AND channel = $2 ${enabledOnly ? 'AND enabled = 1 AND COALESCE(auto_disabled, 0) = 0' : ''} ORDER BY campaign_name, adgroup_name, name`,
    [accountId, channel]
  );
}

async function getMaterialById(id, accountId) {
  return get('SELECT * FROM bid_materials WHERE id = $1 AND account_id = $2', [id, accountId]);
}

async function upsertMaterial(accountId, m, channel = 'shopping') {
  // 동기화에서 다시 발견된 소재/키워드는 자동 비활성 해제 (수동 제외 enabled 는 건드리지 않음)
  const r = await pool.query(`
    INSERT INTO bid_materials (account_id, ncc_ad_id, ncc_adgroup_id, name, campaign_name, adgroup_name, current_bid, use_group_bid, registered_at, auto_disabled, channel, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10, CURRENT_TIMESTAMP)
    ON CONFLICT (account_id, ncc_ad_id) DO UPDATE SET
      ncc_adgroup_id = $3, name = $4, campaign_name = $5, adgroup_name = $6,
      current_bid = $7, use_group_bid = $8, auto_disabled = 0, channel = $10, synced_at = CURRENT_TIMESTAMP
    RETURNING id
  `, [accountId, m.nccAdId, m.nccAdgroupId || '', m.name || '', m.campaignName || '', m.adgroupName || '',
      m.currentBid || 0, m.useGroupBid ? 1 : 0, m.registeredAt || '', channel]);
  return r.rows[0].id;
}

async function setMaterialAutoDisabled(id, autoDisabled) {
  return pool.query('UPDATE bid_materials SET auto_disabled = $2 WHERE id = $1', [id, autoDisabled ? 1 : 0]);
}

async function updateMaterialMeta(id, accountId, { category, target_roas, enabled, mode_override, core_override }) {
  return pool.query(`
    UPDATE bid_materials SET
      category = COALESCE($3, category),
      target_roas = COALESCE($4, target_roas),
      enabled = COALESCE($5, enabled),
      mode_override = COALESCE($6, mode_override),
      core_override = COALESCE($7, core_override)
    WHERE id = $1 AND account_id = $2
  `, [id, accountId, category ?? null, target_roas ?? null, enabled ?? null, mode_override ?? null, core_override ?? null]);
}

async function setMaterialBid(id, bid) {
  return pool.query('UPDATE bid_materials SET current_bid = $2 WHERE id = $1', [id, bid]);
}

// 기준매출 저장 (null 허용) + 변경 시 이력 기록
async function setMaterialBaseline(id, accountId, value, { materialName = '', changedBy = 'cron' } = {}) {
  const old = await get('SELECT baseline_weekly_revenue, channel FROM bid_materials WHERE id = $1 AND account_id = $2', [id, accountId]);
  if (!old) return false;
  const oldVal = old.baseline_weekly_revenue == null ? null : parseInt(old.baseline_weekly_revenue);
  const newVal = value == null ? null : parseInt(value);
  await pool.query('UPDATE bid_materials SET baseline_weekly_revenue = $3 WHERE id = $1 AND account_id = $2', [id, accountId, newVal]);
  if (oldVal !== newVal) {
    await pool.query(
      'INSERT INTO bid_setting_history (account_id, key, old_value, new_value, changed_by) VALUES ($1, $2, $3, $4, $5)',
      [accountId, chKey(`기준매출:${materialName || id}`, old.channel || 'shopping'), oldVal == null ? '-' : String(oldVal), newVal == null ? '-' : String(newVal), changedBy]
    );
  }
  return true;
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

// 주차별 입찰가 스냅샷 기록: week_bid=해당 주 입찰가(최신값), bid_change_from=그 주 첫 변경 전 값 유지
// changedFrom이 null이면 기존 감지값을 보존한다 (같은 주 내 재동기화가 변경 이력을 지우지 않도록)
async function setWeekBid(materialId, weekStart, { weekBid, changedFrom = null }) {
  return pool.query(`
    INSERT INTO bid_weekly_stats (material_id, week_start, week_bid, bid_change_from)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (material_id, week_start) DO UPDATE SET
      week_bid = $3,
      bid_change_from = COALESCE(bid_weekly_stats.bid_change_from, $4)
  `, [materialId, weekStart, weekBid ?? null, changedFrom ?? null]);
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
    SELECT a.*, m.name AS material_name, m.ncc_ad_id, m.campaign_name, m.adgroup_name, m.category, m.current_bid, m.channel
    FROM bid_adjustments a JOIN bid_materials m ON m.id = a.material_id
    WHERE a.id = $1 AND a.account_id = $2
  `, [id, accountId]);
}

async function getAdjustments(accountId, { weekStart, status, statusIn, channel, limit = 500 } = {}) {
  const conds = ['a.account_id = $1'];
  const params = [accountId];
  if (weekStart) { params.push(weekStart); conds.push(`a.week_start = $${params.length}`); }
  if (status) { params.push(status); conds.push(`a.status = $${params.length}`); }
  if (statusIn && statusIn.length) { params.push(statusIn); conds.push(`a.status = ANY($${params.length}::text[])`); }
  if (channel) { params.push(channel); conds.push(`m.channel = $${params.length}`); }
  params.push(limit);
  return all(`
    SELECT a.*, m.name AS material_name, m.ncc_ad_id, m.campaign_name, m.adgroup_name, m.category, m.channel
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

async function getAlerts(accountId, { unresolvedOnly = true, limit = 100, channel = 'shopping' } = {}) {
  return all(`
    SELECT al.*, m.name AS material_name, m.campaign_name, m.adgroup_name, m.current_bid, m.category
    FROM bid_alerts al JOIN bid_materials m ON m.id = al.material_id
    WHERE al.account_id = $1 AND m.channel = $3 ${unresolvedOnly ? 'AND al.resolved = 0' : ''}
    ORDER BY al.alert_date DESC, al.day_cost DESC LIMIT $2
  `, [accountId, limit, channel]);
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

async function getMonthlyReports(accountId, limit = 12, channel = 'shopping') {
  // powerlink 리포트는 month 값에 'pl:' 접두사로 저장된다
  const cond = channel === 'powerlink' ? "AND month LIKE 'pl:%'" : "AND month NOT LIKE 'pl:%'";
  return all(`SELECT * FROM bid_monthly_reports WHERE account_id = $1 ${cond} ORDER BY month DESC LIMIT $2`, [accountId, limit]);
}

// ─── 초대 관리 (account_viewers 확장 — 마스터 공유 모델) ────────────
// 소유자가 아니어도 접근 가능한 광고주의 마스터면 초대를 관리할 수 있다.
// (권한 게이트는 라우트의 requireMaster + 접근 광고주 검증이 담당)
async function listAccountViewers(accountId) {
  return all(`
    SELECT v.*, u.name AS viewer_name FROM account_viewers v
    LEFT JOIN users u ON u.id = v.viewer_user_id
    WHERE v.account_id = $1
    ORDER BY v.created_at DESC
  `, [accountId]);
}

// 초대 생성/재발송 (같은 account+email 재초대 시 토큰·초대일 갱신)
async function createInvite(accountId, invitedBy, email, token) {
  const r = await pool.query(`
    INSERT INTO account_viewers (account_id, email, invite_token, status, invited_by)
    VALUES ($1, $2, $3, 'pending', $4)
    ON CONFLICT (account_id, email) DO UPDATE SET
      invite_token = EXCLUDED.invite_token,
      status = CASE WHEN account_viewers.status = 'accepted' THEN 'accepted' ELSE 'pending' END,
      invited_by = EXCLUDED.invited_by, created_at = CURRENT_TIMESTAMP
    RETURNING *
  `, [accountId, String(email).toLowerCase().trim(), token, invitedBy]);
  return r.rows[0];
}

async function setViewerRole(viewerId, accountId, role) {
  const r = await pool.query(`
    UPDATE account_viewers SET role = $3
    WHERE id = $1 AND account_id = $2
    RETURNING *
  `, [viewerId, accountId, role === 'master' ? 'master' : 'client']);
  return r.rows[0] || null;
}

// 비활성화(disabled) ↔ 재활성화(accepted). accepted 상태였던 계정만 대상.
async function setViewerActive(viewerId, accountId, active) {
  const r = await pool.query(`
    UPDATE account_viewers SET status = $3
    WHERE id = $1 AND account_id = $2
      AND status IN ('accepted','disabled')
    RETURNING *
  `, [viewerId, accountId, active ? 'accepted' : 'disabled']);
  return r.rows[0] || null;
}

// 초대 사용자(users.role='viewer')의 앱 내 역할: master 초대가 1건이라도 있으면 마스터
async function isInvitedMaster(viewerUserId) {
  const r = await get(`SELECT 1 AS ok FROM account_viewers WHERE viewer_user_id = $1 AND status = 'accepted' AND role = 'master' LIMIT 1`, [viewerUserId]);
  return !!r;
}

// ─── 크론 중복 방지 ────────────────────────────────────────────────
async function tryClaimCronRun(runKey, result = '') {
  try {
    // ON CONFLICT: 중복 클레임 시 DB 에러 로그(23505) 없이 조용히 실패 처리
    const r = await pool.query('INSERT INTO bid_cron_runs (run_key, result) VALUES ($1, $2) ON CONFLICT (run_key) DO NOTHING', [runKey, result]);
    return r.rowCount > 0;
  } catch (e) {
    return false; // 이미 실행됨
  }
}

module.exports = {
  pool, initBidDb,
  getSettings, setSetting, getSettingHistory,
  getCategoryRules, setCategoryRule,
  getMaterials, getMaterialById, upsertMaterial, updateMaterialMeta, setMaterialBid, setMaterialBaseline, setMaterialAutoDisabled,
  upsertWeeklyStat, getWeeklyStatsMap, setWeekBid,
  upsertAdjustment, getAdjustmentById, getAdjustments, setAdjustmentStatus,
  listAccountViewers, createInvite, setViewerRole, setViewerActive, isInvitedMaster,
  audit, getAuditLog,
  upsertAlert, getAlerts, resolveAlert,
  saveMonthlyReport, getMonthlyReports,
  tryClaimCronRun,
};
