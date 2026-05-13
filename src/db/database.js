const { Pool } = require('pg');
const crypto = require('crypto');

// ─── PostgreSQL 연결 (Supabase DATABASE_URL) ─────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// 다른 모듈에서 pool을 직접 쓸 수 있도록 export
module.exports.pool = pool;

// ─── 스키마 초기화 ────────────────────────────────────────────────────
async function initDb() {
  const safeQuery = async (sql) => {
    try { await pool.query(sql); } catch (e) {
      if (e.message && e.message.includes('read-only')) return;
      throw e;
    }
  };

  await safeQuery(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      is_admin INTEGER DEFAULT 0,
      approved INTEGER DEFAULT 0,
      api_key TEXT DEFAULT '',
      secret_key TEXT DEFAULT '',
      manager_customer_id TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await safeQuery(`
    CREATE TABLE IF NOT EXISTS ad_accounts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      report_emails TEXT DEFAULT '',
      email_host TEXT DEFAULT 'smtp.gmail.com',
      email_port INTEGER DEFAULT 587,
      email_user TEXT DEFAULT '',
      email_pass TEXT DEFAULT '',
      feat_daily_report INTEGER DEFAULT 0,
      feat_weekly_report INTEGER DEFAULT 0,
      feat_monthly_report INTEGER DEFAULT 0,
      feat_keyword_monitor INTEGER DEFAULT 0,
      feat_auto_bidding INTEGER DEFAULT 0,
      auto_bid_target_rank INTEGER DEFAULT 3,
      auto_bid_max_bid INTEGER DEFAULT 5000,
      auto_bid_min_bid INTEGER DEFAULT 100,
      auto_bid_interval INTEGER DEFAULT 5,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 네이버 마스터 동기화 데이터
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS master_campaigns (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      campaign_name TEXT NOT NULL,
      campaign_tp INTEGER DEFAULT 1,
      delivery_method INTEGER DEFAULT 1,
      use_daily_budget INTEGER DEFAULT 0,
      reg_time TEXT DEFAULT '',
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, campaign_id)
    )
  `);

  await safeQuery(`
    CREATE TABLE IF NOT EXISTS master_adgroups (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      adgroup_id TEXT NOT NULL,
      adgroup_name TEXT NOT NULL,
      campaign_id TEXT NOT NULL,
      use_daily_budget INTEGER DEFAULT 0,
      reg_time TEXT DEFAULT '',
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, adgroup_id)
    )
  `);

  await safeQuery(`
    CREATE TABLE IF NOT EXISTS master_keywords (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL,
      keyword_id TEXT NOT NULL,
      keyword TEXT NOT NULL,
      adgroup_id TEXT NOT NULL,
      bid_amt INTEGER DEFAULT 0,
      use_group_bid INTEGER DEFAULT 0,
      status TEXT DEFAULT '',
      reg_time TEXT DEFAULT '',
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, keyword_id)
    )
  `);

  // ─── 자동입찰 키워드별 설정 ────────────────────────────────────────
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS auto_bid_keywords (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      keyword_id TEXT NOT NULL,
      keyword TEXT NOT NULL DEFAULT '',
      campaign_name TEXT NOT NULL DEFAULT '',
      adgroup_name TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT 'PC',
      target_rank INTEGER NOT NULL DEFAULT 3,
      max_bid INTEGER NOT NULL DEFAULT 5000,
      adjust_amt INTEGER NOT NULL DEFAULT 100,
      schedule TEXT NOT NULL DEFAULT '111111111111111111111111',
      bid_interval INTEGER NOT NULL DEFAULT 10,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_rank REAL DEFAULT 0,
      last_bid INTEGER DEFAULT 0,
      last_run TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, keyword_id, device)
    )
  `);

  // ─── 대시보드 데이터 동기화 테이블 ────────────────────────────────
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS stat_daily_detail (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      stat_date DATE NOT NULL,
      campaign_id TEXT NOT NULL DEFAULT '',
      adgroup_id TEXT NOT NULL DEFAULT '',
      keyword_id TEXT NOT NULL DEFAULT '',
      ad_id TEXT NOT NULL DEFAULT '',
      hour SMALLINT NOT NULL DEFAULT 0,
      device TEXT NOT NULL DEFAULT '',
      imp INTEGER DEFAULT 0,
      clk INTEGER DEFAULT 0,
      cost BIGINT DEFAULT 0,
      rank_val REAL DEFAULT 0,
      purchase_cnt INTEGER DEFAULT 0,
      purchase_amt BIGINT DEFAULT 0,
      cart_cnt INTEGER DEFAULT 0,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await safeQuery(`
    CREATE TABLE IF NOT EXISTS stat_campaign_daily (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      stat_date DATE NOT NULL,
      campaign_id TEXT NOT NULL,
      campaign_name TEXT NOT NULL DEFAULT '',
      imp INTEGER DEFAULT 0,
      clk INTEGER DEFAULT 0,
      sales_amt BIGINT DEFAULT 0,
      avg_rnk REAL DEFAULT 0,
      purchase_cnt INTEGER DEFAULT 0,
      purchase_amt BIGINT DEFAULT 0,
      synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await safeQuery(`
    CREATE TABLE IF NOT EXISTS sync_log (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      sync_type TEXT NOT NULL,
      stat_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_msg TEXT DEFAULT '',
      started_at TIMESTAMP,
      completed_at TIMESTAMP,
      row_count INTEGER DEFAULT 0
    )
  `);

  // 인덱스 생성 (이미 있으면 무시)
  try {
    await safeQuery(`CREATE INDEX IF NOT EXISTS ix_stat_detail_acct_date ON stat_daily_detail (account_id, stat_date)`);
    await safeQuery(`CREATE INDEX IF NOT EXISTS ix_stat_detail_campaign ON stat_daily_detail (account_id, stat_date, campaign_id)`);
    await safeQuery(`CREATE INDEX IF NOT EXISTS ix_stat_camp_daily ON stat_campaign_daily (account_id, stat_date)`);
    await safeQuery(`CREATE UNIQUE INDEX IF NOT EXISTS uix_sync_log ON sync_log (account_id, sync_type, stat_date)`);
  } catch (e) { /* 이미 존재 */ }

  // ad_accounts에 동기화 상태 컬럼 추가
  try {
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'none'`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS campaign_count INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS adgroup_count INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS keyword_count INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_daily_report TIMESTAMP`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_weekly_report TIMESTAMP`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_monthly_report TIMESTAMP`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_dashboard_sync TIMESTAMP`);
    await safeQuery(`ALTER TABLE auto_bid_keywords ADD COLUMN IF NOT EXISTS bid_interval INTEGER NOT NULL DEFAULT 10`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // ad_accounts에 site_url 추가 (비즈채널 URL - 실시간 순위 매칭용)
  try {
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS site_url TEXT DEFAULT ''`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // auto_bid_keywords에 adgroup_id, last_real_rank 추가
  try {
    await safeQuery(`ALTER TABLE auto_bid_keywords ADD COLUMN IF NOT EXISTS adgroup_id TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE auto_bid_keywords ADD COLUMN IF NOT EXISTS last_real_rank INTEGER DEFAULT 0`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // users에 다우오피스 연동 컬럼 추가
  try {
    await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_pass TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS daou_email TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_host TEXT DEFAULT 'outbound.daouoffice.com'`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // ad_accounts에 네이버 광고관리 쿠키 컬럼 추가 (성별/연령 등 고급 리포트 API용)
  try {
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS naver_cookie TEXT DEFAULT ''`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // SA/DA 광고 유형 플래그 + DA 전용 자격증명 (ads.naver.com 세션)
  try {
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS has_sa BOOLEAN DEFAULT true`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS has_da BOOLEAN DEFAULT false`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS da_xsrf_token TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS da_account_no TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS da_helper_images TEXT DEFAULT '[]'`);
    // 전역 설정 (DA 도움말 이미지 등 모든 광고주 공유)
    await safeQuery(`CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // 대행사 (마케터) API 자격증명 - 한 유저당 N개 (이관, 다중 법인 등)
    await safeQuery(`CREATE TABLE IF NOT EXISTS agency_credentials (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT DEFAULT '',
      api_key TEXT NOT NULL,
      secret_key TEXT NOT NULL,
      manager_customer_id TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    await safeQuery(`CREATE INDEX IF NOT EXISTS ix_agency_creds_user ON agency_credentials (user_id)`);
    // 기존 users.api_key 자동 이전 (한 번만)
    await safeQuery(`
      INSERT INTO agency_credentials (user_id, label, api_key, secret_key, manager_customer_id)
      SELECT id, '기본 대행사', api_key, secret_key, manager_customer_id
      FROM users
      WHERE api_key != '' AND secret_key != '' AND manager_customer_id != ''
        AND NOT EXISTS (SELECT 1 FROM agency_credentials WHERE user_id = users.id)
    `);
    // ad_accounts에 사용할 대행사 자격증명 링크
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS agency_credential_id INTEGER`);
    // DA 자동 리포트 기능 플래그
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS feat_da_daily_report INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS feat_da_weekly_report INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS feat_da_monthly_report INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_da_daily_report TIMESTAMP`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_da_weekly_report TIMESTAMP`);
    await safeQuery(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_da_monthly_report TIMESTAMP`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // master_keywords에 품질지수(Qi) 컬럼 추가
  try {
    await safeQuery(`ALTER TABLE master_keywords ADD COLUMN IF NOT EXISTS qi_grade INTEGER DEFAULT 0`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // master_campaigns에 확장 필드 추가 (ON/OFF, 예산, 기간)
  try {
    await safeQuery(`ALTER TABLE master_campaigns ADD COLUMN IF NOT EXISTS user_lock INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE master_campaigns ADD COLUMN IF NOT EXISTS daily_budget BIGINT DEFAULT 0`);
    await safeQuery(`ALTER TABLE master_campaigns ADD COLUMN IF NOT EXISTS use_period INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE master_campaigns ADD COLUMN IF NOT EXISTS period_start TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE master_campaigns ADD COLUMN IF NOT EXISTS period_end TEXT DEFAULT ''`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // master_adgroups에 확장 필드 추가 (입찰가, 키워드확장, ON/OFF, 상태)
  try {
    await safeQuery(`ALTER TABLE master_adgroups ADD COLUMN IF NOT EXISTS bid_amt INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE master_adgroups ADD COLUMN IF NOT EXISTS user_lock INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE master_adgroups ADD COLUMN IF NOT EXISTS use_keyword_plus INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE master_adgroups ADD COLUMN IF NOT EXISTS keyword_plus_weight INTEGER DEFAULT 100`);
    await safeQuery(`ALTER TABLE master_adgroups ADD COLUMN IF NOT EXISTS status TEXT DEFAULT ''`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // master_keywords에 확장 필드 추가 (ON/OFF, 검수상태, 랜딩URL)
  try {
    await safeQuery(`ALTER TABLE master_keywords ADD COLUMN IF NOT EXISTS user_lock INTEGER DEFAULT 0`);
    await safeQuery(`ALTER TABLE master_keywords ADD COLUMN IF NOT EXISTS inspect_status TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE master_keywords ADD COLUMN IF NOT EXISTS pc_landing_url TEXT DEFAULT ''`);
    await safeQuery(`ALTER TABLE master_keywords ADD COLUMN IF NOT EXISTS mo_landing_url TEXT DEFAULT ''`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // ─── 쇼핑검색 자동입찰 키워드 테이블 ──────────────────────────────
  await safeQuery(`
    CREATE TABLE IF NOT EXISTS shopping_bid_keywords (
      id SERIAL PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES ad_accounts(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL DEFAULT '',
      product_url TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT 'MO',
      target_rank INTEGER NOT NULL DEFAULT 1,
      max_bid INTEGER NOT NULL DEFAULT 5000,
      adjust_amt INTEGER NOT NULL DEFAULT 100,
      schedule TEXT NOT NULL DEFAULT '111111111111111111111111',
      bid_interval INTEGER NOT NULL DEFAULT 10,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_rank INTEGER DEFAULT 0,
      last_bid INTEGER DEFAULT 0,
      last_run TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(account_id, keyword, device)
    )
  `);

  console.log('✅ DB 초기화 완료 (Supabase PostgreSQL)');
}

// ─── 비밀번호 해싱 ────────────────────────────────────────────────────
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  return attempt === hash;
}

// ─── 쿼리 헬퍼 ────────────────────────────────────────────────────────
const query = (sql, params = []) => pool.query(sql, params);

const get = async (sql, params = []) => {
  const result = await pool.query(sql, params);
  return result.rows[0] || null;
};

const all = async (sql, params = []) => {
  const result = await pool.query(sql, params);
  return result.rows;
};

// ─── Users ───────────────────────────────────────────────────────────
async function createUser(username, password, name, { isAdmin = 0, approved = 0, daouEmail = '', daouPass = '' } = {}) {
  const passwordHash = hashPassword(password);
  const result = await pool.query(
    'INSERT INTO users (username, password_hash, name, is_admin, approved, daou_email, smtp_pass) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
    [username, passwordHash, name, isAdmin ? 1 : 0, approved ? 1 : 0, daouEmail, daouPass]
  );
  return result.rows[0].id;
}

async function getUserByUsername(username) {
  return get('SELECT * FROM users WHERE username = $1', [username]);
}

async function getUserById(id) {
  return get(
    'SELECT id, username, name, is_admin, approved, api_key, secret_key, manager_customer_id, created_at FROM users WHERE id = $1',
    [id]
  );
}

async function authenticateUser(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, name: user.name, is_admin: user.is_admin, approved: user.approved };
}

async function countUsers() {
  const row = await get('SELECT COUNT(*) AS cnt FROM users');
  return parseInt(row?.cnt || 0);
}

async function getAllUsers() {
  return all('SELECT id, username, name, is_admin, approved, created_at FROM users ORDER BY created_at DESC');
}

async function getPendingUsers() {
  return all('SELECT id, username, name, created_at FROM users WHERE approved = 0 ORDER BY created_at ASC');
}

async function approveUser(userId) {
  return query('UPDATE users SET approved = 1 WHERE id = $1', [userId]);
}

async function rejectUser(userId) {
  return query('UPDATE users SET approved = -1 WHERE id = $1 AND is_admin = 0', [userId]);
}

// ─── SMTP 자격증명 (다우오피스 자동 연동) ──────────────────────────────
async function getSmtpCredentials(userId) {
  return get('SELECT username, smtp_pass, daou_email, smtp_host FROM users WHERE id = $1', [userId]);
}

// ─── API 자격증명 ─────────────────────────────────────────────────────
async function updateApiCredentials(userId, apiKey, secretKey, managerCustomerId) {
  return query(
    'UPDATE users SET api_key = $1, secret_key = $2, manager_customer_id = $3 WHERE id = $4',
    [apiKey, secretKey, managerCustomerId, userId]
  );
}

// ─── 대행사 자격증명 다중 관리 ───────────────────────────────────
async function listAgencyCredentials(userId) {
  return all('SELECT id, label, manager_customer_id, api_key, secret_key, created_at FROM agency_credentials WHERE user_id = $1 ORDER BY id ASC', [userId]);
}
async function addAgencyCredential(userId, { label, api_key, secret_key, manager_customer_id }) {
  const r = await query(
    'INSERT INTO agency_credentials (user_id, label, api_key, secret_key, manager_customer_id) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [userId, label || '', api_key, secret_key, manager_customer_id]
  );
  return r.rows[0]?.id;
}
async function updateAgencyCredential(id, userId, { label, api_key, secret_key, manager_customer_id }) {
  return query(
    'UPDATE agency_credentials SET label=$1, api_key=$2, secret_key=$3, manager_customer_id=$4 WHERE id=$5 AND user_id=$6',
    [label || '', api_key, secret_key, manager_customer_id, id, userId]
  );
}
async function deleteAgencyCredential(id, userId) {
  return query('DELETE FROM agency_credentials WHERE id = $1 AND user_id = $2', [id, userId]);
}
async function getAgencyCredentialById(id, userId) {
  return get('SELECT id, label, api_key, secret_key, manager_customer_id FROM agency_credentials WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function getApiCredentials(userId, accountId) {
  // accountId가 주어지면 해당 광고주가 연결된 agency_credential 우선 조회
  if (accountId) {
    const linked = await get(`
      SELECT ac.id, ac.api_key, ac.secret_key, ac.manager_customer_id
      FROM ad_accounts a
      JOIN agency_credentials ac ON ac.id = a.agency_credential_id
      WHERE a.id = $1 AND a.user_id = $2 AND ac.api_key != ''
    `, [accountId, userId]);
    if (linked) return linked;
  }
  // 폴백: 유저의 첫 번째 agency_credential
  const first = await get('SELECT id, api_key, secret_key, manager_customer_id FROM agency_credentials WHERE user_id = $1 ORDER BY id ASC LIMIT 1', [userId]);
  if (first && first.api_key) return first;
  // 레거시 폴백: users 테이블
  return _getApiCredentialsLegacy(userId);
}
async function _getApiCredentialsLegacy(userId) {
  const row = await get(
    'SELECT api_key, secret_key, manager_customer_id FROM users WHERE id = $1',
    [userId]
  );
  if (!row || !row.api_key) return null;
  return row;
}

// ─── Ad Accounts ─────────────────────────────────────────────────────
async function getAccountsByUser(userId) {
  return all('SELECT * FROM ad_accounts WHERE user_id = $1 ORDER BY created_at ASC', [userId]);
}

async function getAccountById(id, userId) {
  return get('SELECT * FROM ad_accounts WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function getAccountByCustomerId(customerId, userId) {
  return get('SELECT * FROM ad_accounts WHERE customer_id = $1 AND user_id = $2', [customerId, userId]);
}

async function getAllAccountsWithFeature(feature) {
  const col = `feat_${feature}`;
  // 광고주에 연결된 agency_credential 우선, 없으면 users 테이블 폴백
  return all(`
    SELECT ad_accounts.*,
           users.name AS user_name,
           COALESCE(ac.api_key, users.api_key) AS api_key,
           COALESCE(ac.secret_key, users.secret_key) AS secret_key,
           COALESCE(ac.manager_customer_id, users.manager_customer_id) AS manager_customer_id
    FROM ad_accounts
    JOIN users ON users.id = ad_accounts.user_id
    LEFT JOIN agency_credentials ac ON ac.id = ad_accounts.agency_credential_id
    WHERE ad_accounts.${col} = 1
      AND users.api_key != ''
  `);
}

async function addSelectedAccount(userId, customerId, name) {
  const existing = await getAccountByCustomerId(customerId, userId);
  if (existing) return existing.id;
  const result = await pool.query(
    'INSERT INTO ad_accounts (user_id, customer_id, name) VALUES ($1, $2, $3) RETURNING id',
    [userId, customerId, name]
  );
  return result.rows[0].id;
}

async function updateAccount(id, userId, data) {
  return query(`
    UPDATE ad_accounts SET
      name = $1,
      report_emails = $2, email_host = $3, email_port = $4,
      email_user = $5, email_pass = $6,
      feat_daily_report = $7, feat_weekly_report = $8, feat_monthly_report = $9,
      feat_keyword_monitor = $10, feat_auto_bidding = $11,
      auto_bid_target_rank = $12, auto_bid_max_bid = $13,
      auto_bid_min_bid = $14, auto_bid_interval = $15,
      site_url = $18, naver_cookie = $19,
      has_sa = $20, has_da = $21, da_xsrf_token = $22, da_account_no = $23
    WHERE id = $16 AND user_id = $17
  `, [
    data.name,
    data.report_emails || '',
    data.email_host || 'smtp.gmail.com',
    parseInt(data.email_port) || 587,
    data.email_user || '',
    data.email_pass || '',
    data.feat_daily_report ? 1 : 0,
    data.feat_weekly_report ? 1 : 0,
    data.feat_monthly_report ? 1 : 0,
    data.feat_keyword_monitor ? 1 : 0,
    data.feat_auto_bidding ? 1 : 0,
    parseInt(data.auto_bid_target_rank) || 3,
    parseInt(data.auto_bid_max_bid) || 5000,
    parseInt(data.auto_bid_min_bid) || 100,
    parseInt(data.auto_bid_interval) || 5,
    id, userId,
    data.site_url || '',
    data.naver_cookie || '',
    data.has_sa === false || data.has_sa === 0 || data.has_sa === '0' ? false : true,
    data.has_da === true || data.has_da === 1 || data.has_da === '1' || data.has_da === 'on' ? true : false,
    data.da_xsrf_token || '',
    data.da_account_no || '',
  ]);
}

async function deleteAccount(id, userId) {
  return query('DELETE FROM ad_accounts WHERE id = $1 AND user_id = $2', [id, userId]);
}

// 관리자 비밀번호 초기화 (CRON_SECRET으로 보호)
async function resetAdminPassword(newPassword) {
  const passwordHash = hashPassword(newPassword);
  await pool.query(
    'UPDATE users SET password_hash = $1 WHERE is_admin = 1',
    [passwordHash]
  );
}

// 전체 사용자 삭제 (최초 재등록용)
async function deleteAllUsers() {
  await pool.query('DELETE FROM ad_accounts');
  await pool.query('DELETE FROM users');
}

// ─── 네이버 마스터 동기화 ─────────────────────────────────────────────
async function updateSyncStatus(accountId, status, counts = {}) {
  const sets = ['sync_status = $1', 'synced_at = CURRENT_TIMESTAMP'];
  const vals = [status];
  let idx = 2;
  if (counts.campaigns !== undefined) { sets.push(`campaign_count = $${idx++}`); vals.push(counts.campaigns); }
  if (counts.adgroups !== undefined)  { sets.push(`adgroup_count = $${idx++}`); vals.push(counts.adgroups); }
  if (counts.keywords !== undefined)  { sets.push(`keyword_count = $${idx++}`); vals.push(counts.keywords); }
  vals.push(accountId);
  await pool.query(`UPDATE ad_accounts SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

async function upsertMasterCampaigns(accountId, rows) {
  await pool.query('DELETE FROM master_campaigns WHERE account_id = $1', [accountId]);
  // Campaign TSV: [0]customerId, [1]campaignId, [2]name, [3]campaignTp, [4]deliveryMethod,
  //   [5]useDailyBudget, [6]dailyBudget, [7]userLock, [8]regTime, [9]editTime,
  //   [10]usePeriod, [11]periodStartDt, [12]periodEndDt
  for (const r of rows) {
    await pool.query(
      `INSERT INTO master_campaigns (account_id, customer_id, campaign_id, campaign_name, campaign_tp, delivery_method, use_daily_budget, daily_budget, user_lock, reg_time, use_period, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [accountId, r[0], r[1], r[2],
       parseInt(r[3]) || 1, parseInt(r[4]) || 1, parseInt(r[5]) || 0,
       parseInt(r[6]) || 0, parseInt(r[7]) || 0, r[8] || '',
       parseInt(r[10]) || 0, r[11] || '', r[12] || '']
    );
  }
}

async function upsertMasterAdgroups(accountId, rows) {
  await pool.query('DELETE FROM master_adgroups WHERE account_id = $1', [accountId]);
  // Adgroup TSV: [0]customerId, [1]adgroupId, [2]campaignId, [3]name, [4]useDailyBudget,
  //   [5]dailyBudget, [6]bidAmt, [7]regTime, [8]editTime, [9]userLock,
  //   [10]useKeywordPlus, [11]keywordPlusWeight, ... [16]status, [17]statusReason
  for (const r of rows) {
    if (r.length < 4) continue;
    await pool.query(
      `INSERT INTO master_adgroups (account_id, customer_id, adgroup_id, adgroup_name, campaign_id, use_daily_budget, bid_amt, reg_time, user_lock, use_keyword_plus, keyword_plus_weight, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [accountId, r[0], r[1], r[3] || '', r[2] || '',
       parseInt(r[4]) || 0, parseInt(r[6]) || 0, r[7] || '',
       parseInt(r[9]) || 0, parseInt(r[10]) || 0, parseInt(r[11]) || 100,
       r.length > 16 ? (r[16] || '') : '']
    );
  }
}

async function upsertMasterKeywords(accountId, rows) {
  await pool.query('DELETE FROM master_keywords WHERE account_id = $1', [accountId]);
  // Keyword TSV: [0]customerId, [1]adgroupId, [2]keywordId, [3]keyword, [4]bidAmt,
  //   [5]useGroupBidAmt, [6]userLock, [7]inspectStatus, [8]status, [9]regTime,
  //   [10]editTime, [11]pcLandingUrl, [12]moLandingUrl
  for (const r of rows) {
    if (r.length < 4) continue;
    try {
      await pool.query(
        `INSERT INTO master_keywords (account_id, customer_id, keyword_id, keyword, adgroup_id, bid_amt, use_group_bid, user_lock, inspect_status, status, reg_time, pc_landing_url, mo_landing_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [accountId, r[0], r[2], r[3] || '', r[1] || '',
         parseInt(r[4]) || 0, parseInt(r[5]) || 0,
         parseInt(r[6]) || 0, r[7] || '', r[8] || '', r[9] || '',
         r[11] || '', r[12] || '']
      );
    } catch (e) {
      if (!e.message.includes('duplicate')) console.log(`키워드 저장 실패: ${e.message}`);
    }
  }
}

/**
 * Qi(품질지수) 마스터 동기화 → master_keywords.qi_grade 업데이트
 * Qi TSV: [0]customerId, [1]keywordId, [2]qi(1~7)
 */
async function upsertMasterQi(accountId, rows) {
  let updated = 0;
  for (const r of rows) {
    if (r.length < 3) continue;
    const keywordId = r[1];
    const qi = parseInt(r[2]) || 0;
    if (qi <= 0) continue;
    const result = await pool.query(
      'UPDATE master_keywords SET qi_grade = $1 WHERE account_id = $2 AND keyword_id = $3',
      [qi, accountId, keywordId]
    );
    if (result.rowCount > 0) updated++;
  }
  return updated;
}

async function getMasterCampaigns(accountId) {
  return all('SELECT * FROM master_campaigns WHERE account_id = $1 ORDER BY campaign_name', [accountId]);
}

async function getMasterAdgroups(accountId) {
  return all('SELECT * FROM master_adgroups WHERE account_id = $1 ORDER BY adgroup_name', [accountId]);
}

async function getMasterKeywords(accountId, adgroupId) {
  if (adgroupId) {
    return all('SELECT * FROM master_keywords WHERE account_id = $1 AND adgroup_id = $2 ORDER BY keyword', [accountId, adgroupId]);
  }
  return all('SELECT * FROM master_keywords WHERE account_id = $1 ORDER BY keyword', [accountId]);
}

// 키워드ID → { keyword, campaignTp } 매핑 빌드
async function buildKeywordMaps(accountId) {
  const campaigns = await getMasterCampaigns(accountId);
  const adgroups = await getMasterAdgroups(accountId);
  const keywords = await getMasterKeywords(accountId);

  const campMap = {};   // campaignId → { name, tp }
  for (const c of campaigns) campMap[c.campaign_id] = { name: c.campaign_name, tp: c.campaign_tp };

  const agMap = {};     // adgroupId → { name, campaignId }
  for (const ag of adgroups) agMap[ag.adgroup_id] = { name: ag.adgroup_name, campaignId: ag.campaign_id };

  const kwMap = {};     // keywordId → { keyword, adgroupId, adgroupName, campaignId, campaignName, campaignTp }
  for (const kw of keywords) {
    const ag = agMap[kw.adgroup_id] || {};
    const camp = campMap[ag.campaignId] || {};
    kwMap[kw.keyword_id] = {
      keyword: kw.keyword,
      adgroupId: kw.adgroup_id,
      adgroupName: ag.name || '',
      campaignId: ag.campaignId || '',
      campaignName: camp.name || '',
      campaignTp: camp.tp || 1,
      qi: kw.qi_grade || 0,
    };
  }

  return { campMap, agMap, kwMap };
}

// ─── 자동입찰 키워드 관리 ─────────────────────────────────────────────
async function getAutoBidKeywords(accountId) {
  return all('SELECT * FROM auto_bid_keywords WHERE account_id = $1 ORDER BY campaign_name, adgroup_name, keyword', [accountId]);
}

async function upsertAutoBidKeyword(accountId, data) {
  return pool.query(`
    INSERT INTO auto_bid_keywords (account_id, keyword_id, keyword, campaign_name, adgroup_name, device, target_rank, max_bid, adjust_amt, schedule, bid_interval, enabled, adgroup_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (account_id, keyword_id, device)
    DO UPDATE SET keyword = $3, campaign_name = $4, adgroup_name = $5,
      target_rank = $7, max_bid = $8, adjust_amt = $9, schedule = $10, bid_interval = $11, enabled = $12, adgroup_id = $13
  `, [accountId, data.keyword_id, data.keyword, data.campaign_name, data.adgroup_name,
      data.device, data.target_rank, data.max_bid, data.adjust_amt, data.schedule,
      parseInt(data.bid_interval) || 10, data.enabled ? 1 : 0, data.adgroup_id || '']);
}

async function deleteAutoBidKeyword(id, accountId) {
  return pool.query('DELETE FROM auto_bid_keywords WHERE id = $1 AND account_id = $2', [id, accountId]);
}

async function updateAutoBidKeywordStatus(keywordId, device, rank, bid, realRank = null) {
  if (realRank !== null && rank > 0) {
    // 순위 평균 입찰가 + 현재입찰가 + 실시간순위 모두 갱신
    return pool.query(
      'UPDATE auto_bid_keywords SET last_rank = $1, last_bid = $2, last_real_rank = $5, last_run = CURRENT_TIMESTAMP WHERE keyword_id = $3 AND device = $4',
      [rank, bid, keywordId, device, realRank]
    );
  }
  if (realRank !== null) {
    // 현재입찰가 + 실시간순위만 갱신 (순위 평균 입찰가 유지)
    return pool.query(
      'UPDATE auto_bid_keywords SET last_bid = $1, last_real_rank = $4, last_run = CURRENT_TIMESTAMP WHERE keyword_id = $2 AND device = $3',
      [bid, keywordId, device, realRank]
    );
  }
  if (rank > 0) {
    return pool.query(
      'UPDATE auto_bid_keywords SET last_rank = $1, last_bid = $2, last_run = CURRENT_TIMESTAMP WHERE keyword_id = $3 AND device = $4',
      [rank, bid, keywordId, device]
    );
  }
  // 현재입찰가만 갱신
  return pool.query(
    'UPDATE auto_bid_keywords SET last_bid = $1, last_run = CURRENT_TIMESTAMP WHERE keyword_id = $2 AND device = $3',
    [bid, keywordId, device]
  );
}

async function getEnabledAutoBidKeywords(accountId) {
  return all('SELECT * FROM auto_bid_keywords WHERE account_id = $1 AND enabled = 1', [accountId]);
}

// ─── 대시보드 동기화 데이터 조회 ─────────────────────────────────────

/** 해당 기간의 동기화 상태 확인 */
async function isSynced(accountId, since, until) {
  const dates = [];
  const s = new Date(since), e = new Date(until);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) dates.push(d.toISOString().slice(0, 10));

  const result = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM sync_log
     WHERE account_id = $1 AND sync_type = 'detail' AND status = 'done'
     AND stat_date >= $2 AND stat_date <= $3`,
    [accountId, since, until]
  );
  return result.rows[0].cnt >= dates.length;
}

/** 요약 탭: 캠페인별 Stats API 데이터 (정확한 salesAmt) */
async function queryStatsSummary(accountId, since, until) {
  const totals = await get(`
    SELECT COALESCE(SUM(imp),0)::int AS "impCnt", COALESCE(SUM(clk),0)::int AS "clkCnt",
           COALESCE(SUM(sales_amt),0)::bigint AS "salesAmt",
           COALESCE(SUM(purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_campaign_daily WHERE account_id = $1 AND stat_date >= $2 AND stat_date <= $3
  `, [accountId, since, until]);

  const campaigns = await all(`
    SELECT campaign_id AS id, campaign_name AS name,
           COALESCE(SUM(imp),0)::int AS "impCnt", COALESCE(SUM(clk),0)::int AS "clkCnt",
           COALESCE(SUM(sales_amt),0)::bigint AS "salesAmt",
           COALESCE(SUM(purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(purchase_amt),0)::bigint AS "purchaseAmt",
           CASE WHEN COUNT(NULLIF(avg_rnk,0)) > 0 THEN AVG(NULLIF(avg_rnk,0)) ELSE 0 END AS "avgRnk"
    FROM stat_campaign_daily WHERE account_id = $1 AND stat_date >= $2 AND stat_date <= $3
    GROUP BY campaign_id, campaign_name ORDER BY SUM(sales_amt) DESC
  `, [accountId, since, until]);

  // 계산 필드
  const t = totals || { impCnt: 0, clkCnt: 0, salesAmt: 0, purchaseCnt: 0, purchaseAmt: 0 };
  t.ctr = t.impCnt > 0 ? (t.clkCnt / t.impCnt * 100) : 0;
  t.cpc = t.clkCnt > 0 ? Math.round(Number(t.salesAmt) / t.clkCnt) : 0;
  t.roas = Number(t.salesAmt) > 0 ? Math.round(Number(t.purchaseAmt) / Number(t.salesAmt) * 100) : 0;
  // avgRnk from campaigns
  const rankedCamps = campaigns.filter(c => Number(c.avgRnk) > 0);
  t.avgRnk = rankedCamps.length > 0 ? rankedCamps.reduce((s, c) => s + Number(c.avgRnk), 0) / rankedCamps.length : 0;

  const campStats = campaigns.map(c => ({
    ...c,
    salesAmt: Number(c.salesAmt),
    purchaseAmt: Number(c.purchaseAmt),
    avgRnk: Number(c.avgRnk),
    ctr: c.impCnt > 0 ? (c.clkCnt / c.impCnt * 100) : 0,
    cpc: c.clkCnt > 0 ? Math.round(Number(c.salesAmt) / c.clkCnt) : 0,
    convAmt: Number(c.purchaseAmt),
    ccnt: c.purchaseCnt,
  }));

  return {
    impCnt: t.impCnt, clkCnt: t.clkCnt, salesAmt: Number(t.salesAmt),
    ctr: t.ctr, cpc: t.cpc, avgRnk: t.avgRnk,
    purchaseAmt: Number(t.purchaseAmt), purchaseCnt: t.purchaseCnt, roas: t.roas,
    convAmt: Number(t.purchaseAmt), ccnt: t.purchaseCnt,
    campStats,
  };
}

/** 키워드 탭 */
async function queryStatsKeywords(accountId, since, until) {
  // 파워링크: keyword_id로 그룹핑, 키워드 텍스트 + 품질지수(Qi) 표시
  const powerlink = await all(`
    SELECT d.keyword_id, d.adgroup_id, d.campaign_id,
           CASE WHEN d.keyword_id = '-' THEN COALESCE(ma.adgroup_name, d.adgroup_id) ELSE COALESCE(mk.keyword, d.keyword_id) END AS keyword,
           COALESCE(mc.campaign_name, d.campaign_id) AS "campaignName",
           COALESCE(mc.campaign_tp, 1) AS "campaignTp",
           COALESCE(ma.adgroup_name, d.adgroup_id) AS "adgroupName",
           COALESCE(mk.qi_grade, 0)::int AS "qiGrade",
           COALESCE(SUM(d.imp),0)::int AS imp, COALESCE(SUM(d.clk),0)::int AS clk,
           COALESCE(SUM(d.cost),0)::bigint AS cost,
           COALESCE(SUM(d.purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(d.purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_daily_detail d
    LEFT JOIN master_keywords mk ON mk.account_id = d.account_id AND mk.keyword_id = d.keyword_id
    LEFT JOIN master_adgroups ma ON ma.account_id = d.account_id AND ma.adgroup_id = d.adgroup_id
    LEFT JOIN master_campaigns mc ON mc.account_id = d.account_id AND mc.campaign_id = d.campaign_id
    WHERE d.account_id = $1 AND d.stat_date >= $2 AND d.stat_date <= $3
      AND (mc.campaign_tp IS NULL OR mc.campaign_tp != 2)
      AND d.keyword_id != '-' AND d.keyword_id != '' AND d.keyword_id != '0'
    GROUP BY d.keyword_id, d.adgroup_id, d.campaign_id, mk.keyword, mc.campaign_name, mc.campaign_tp, ma.adgroup_name, mk.qi_grade
    ORDER BY SUM(d.cost) DESC
  `, [accountId, since, until]);

  // 쇼핑검색: SHOPPINGKEYWORD_DETAIL 동기화 후 keyword_id에 검색어 텍스트가 저장됨
  // keyword_id로 그룹핑 → 검색어 텍스트 그대로 표시
  let shopping = await all(`
    SELECT d.keyword_id, d.adgroup_id, d.campaign_id,
           d.keyword_id AS keyword,
           COALESCE(mc.campaign_name, d.campaign_id) AS "campaignName",
           2 AS "campaignTp",
           COALESCE(ma.adgroup_name, d.adgroup_id) AS "adgroupName",
           0 AS "qiGrade",
           COALESCE(SUM(d.imp),0)::int AS imp, COALESCE(SUM(d.clk),0)::int AS clk,
           COALESCE(SUM(d.cost),0)::bigint AS cost,
           COALESCE(SUM(d.purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(d.purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_daily_detail d
    LEFT JOIN master_adgroups ma ON ma.account_id = d.account_id AND ma.adgroup_id = d.adgroup_id
    LEFT JOIN master_campaigns mc ON mc.account_id = d.account_id AND mc.campaign_id = d.campaign_id
    WHERE d.account_id = $1 AND d.stat_date >= $2 AND d.stat_date <= $3
      AND mc.campaign_tp = 2
      AND d.keyword_id != '-' AND d.keyword_id != '' AND d.keyword_id != '0'
    GROUP BY d.keyword_id, d.adgroup_id, d.campaign_id, ma.adgroup_name, mc.campaign_name
    ORDER BY SUM(d.cost) DESC
  `, [accountId, since, until]);

  // 폴백: 쇼핑 키워드 데이터가 없으면 그룹별 집계로 표시
  if (shopping.length === 0) {
    shopping = await all(`
      SELECT d.adgroup_id AS keyword_id, d.adgroup_id, d.campaign_id,
             COALESCE(ma.adgroup_name, d.adgroup_id) AS keyword,
             COALESCE(mc.campaign_name, d.campaign_id) AS "campaignName",
             2 AS "campaignTp",
             COALESCE(ma.adgroup_name, d.adgroup_id) AS "adgroupName",
             0 AS "qiGrade",
             COALESCE(SUM(d.imp),0)::int AS imp, COALESCE(SUM(d.clk),0)::int AS clk,
             COALESCE(SUM(d.cost),0)::bigint AS cost,
             COALESCE(SUM(d.purchase_cnt),0)::int AS "purchaseCnt",
             COALESCE(SUM(d.purchase_amt),0)::bigint AS "purchaseAmt"
      FROM stat_daily_detail d
      LEFT JOIN master_adgroups ma ON ma.account_id = d.account_id AND ma.adgroup_id = d.adgroup_id
      LEFT JOIN master_campaigns mc ON mc.account_id = d.account_id AND mc.campaign_id = d.campaign_id
      WHERE d.account_id = $1 AND d.stat_date >= $2 AND d.stat_date <= $3
        AND mc.campaign_tp = 2
      GROUP BY d.adgroup_id, d.campaign_id, ma.adgroup_name, mc.campaign_name
      HAVING SUM(d.imp) > 0 OR SUM(d.clk) > 0 OR SUM(d.cost) > 0
      ORDER BY SUM(d.cost) DESC
    `, [accountId, since, until]);
  }

  return [...powerlink, ...shopping];
}

/** 시간대별 탭 */
async function queryStatsHourly(accountId, since, until, campaignIds) {
  const hasCamp = Array.isArray(campaignIds) && campaignIds.length > 0;
  const campClause = hasCamp ? ` AND campaign_id = ANY($4)` : '';
  const params = hasCamp ? [accountId, since, until, campaignIds.map(String)] : [accountId, since, until];
  const byHour = await all(`
    SELECT hour, COALESCE(SUM(imp),0)::int AS imp, COALESCE(SUM(clk),0)::int AS clk,
           COALESCE(SUM(cost),0)::bigint AS cost,
           COALESCE(SUM(purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_daily_detail WHERE account_id = $1 AND stat_date >= $2 AND stat_date <= $3${campClause}
    GROUP BY hour ORDER BY hour
  `, params);

  const byDay = await all(`
    SELECT EXTRACT(DOW FROM stat_date)::int AS dow,
           COALESCE(SUM(imp),0)::int AS imp, COALESCE(SUM(clk),0)::int AS clk,
           COALESCE(SUM(cost),0)::bigint AS cost,
           COALESCE(SUM(purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_daily_detail WHERE account_id = $1 AND stat_date >= $2 AND stat_date <= $3${campClause}
    GROUP BY dow ORDER BY dow
  `, params);

  return { byHour, byDay };
}

/** 디바이스별 탭 */
async function queryStatsDevice(accountId, since, until) {
  return all(`
    SELECT device, COALESCE(SUM(imp),0)::int AS imp, COALESCE(SUM(clk),0)::int AS clk,
           COALESCE(SUM(cost),0)::bigint AS cost,
           COALESCE(SUM(purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_daily_detail WHERE account_id = $1 AND stat_date >= $2 AND stat_date <= $3
    GROUP BY device
  `, [accountId, since, until]);
}

/** 캠페인별 탭 */
async function queryStatsCampaigns(accountId, since, until) {
  return all(`
    SELECT d.campaign_id,
           COALESCE(mc.campaign_name, d.campaign_id) AS "campaignName",
           COALESCE(mc.campaign_tp, 1) AS "campaignTp",
           COALESCE(SUM(d.imp),0)::int AS imp, COALESCE(SUM(d.clk),0)::int AS clk,
           COALESCE(SUM(d.cost),0)::bigint AS cost,
           COALESCE(SUM(d.purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(d.purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_daily_detail d
    LEFT JOIN master_campaigns mc ON mc.account_id = d.account_id AND mc.campaign_id = d.campaign_id
    WHERE d.account_id = $1 AND d.stat_date >= $2 AND d.stat_date <= $3
    GROUP BY d.campaign_id, mc.campaign_name, mc.campaign_tp
    ORDER BY SUM(d.cost) DESC
  `, [accountId, since, until]);
}

/** 광고그룹별 탭 */
async function queryStatsAdgroups(accountId, since, until) {
  return all(`
    SELECT d.adgroup_id, d.campaign_id,
           COALESCE(ma.adgroup_name, d.adgroup_id) AS "adgroupName",
           COALESCE(mc.campaign_name, d.campaign_id) AS "campaignName",
           COALESCE(mc.campaign_tp, 1) AS "campaignTp",
           COALESCE(SUM(d.imp),0)::int AS imp, COALESCE(SUM(d.clk),0)::int AS clk,
           COALESCE(SUM(d.cost),0)::bigint AS cost,
           COALESCE(SUM(d.purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(d.purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_daily_detail d
    LEFT JOIN master_adgroups ma ON ma.account_id = d.account_id AND ma.adgroup_id = d.adgroup_id
    LEFT JOIN master_campaigns mc ON mc.account_id = d.account_id AND mc.campaign_id = d.campaign_id
    WHERE d.account_id = $1 AND d.stat_date >= $2 AND d.stat_date <= $3
    GROUP BY d.adgroup_id, d.campaign_id, ma.adgroup_name, mc.campaign_name, mc.campaign_tp
    ORDER BY SUM(d.cost) DESC
  `, [accountId, since, until]);
}

// ─── 쇼핑검색 자동입찰 키워드 관리 ──────────────────────────────────
async function getShoppingBidKeywords(accountId) {
  return all('SELECT * FROM shopping_bid_keywords WHERE account_id = $1 ORDER BY keyword', [accountId]);
}

async function upsertShoppingBidKeyword(accountId, data) {
  return pool.query(`
    INSERT INTO shopping_bid_keywords (account_id, keyword, product_url, product_name, device, target_rank, max_bid, adjust_amt, schedule, bid_interval, enabled)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (account_id, keyword, device)
    DO UPDATE SET product_url = $3, product_name = $4,
      target_rank = $6, max_bid = $7, adjust_amt = $8, schedule = $9, bid_interval = $10, enabled = $11
  `, [accountId, data.keyword, data.product_url || '', data.product_name || '',
      data.device, data.target_rank, data.max_bid, data.adjust_amt, data.schedule,
      parseInt(data.bid_interval) || 10, data.enabled ? 1 : 0]);
}

async function deleteShoppingBidKeyword(id, accountId) {
  return pool.query('DELETE FROM shopping_bid_keywords WHERE id = $1 AND account_id = $2', [id, accountId]);
}

async function updateShoppingBidKeywordStatus(id, rank, bid) {
  if (rank > 0) {
    return pool.query(
      'UPDATE shopping_bid_keywords SET last_rank = $1, last_bid = $2, last_run = CURRENT_TIMESTAMP WHERE id = $3',
      [rank, bid, id]
    );
  }
  return pool.query(
    'UPDATE shopping_bid_keywords SET last_bid = $1, last_run = CURRENT_TIMESTAMP WHERE id = $2',
    [bid, id]
  );
}

async function getEnabledShoppingBidKeywords(accountId) {
  return all('SELECT * FROM shopping_bid_keywords WHERE account_id = $1 AND enabled = 1', [accountId]);
}

/** 일자별 추이 데이터 (성과지표 트렌드 차트용) */
async function queryStatsTrend(accountId, since, until) {
  return all(`
    SELECT stat_date::text AS date,
           COALESCE(SUM(imp),0)::int AS imp,
           COALESCE(SUM(clk),0)::int AS clk,
           COALESCE(SUM(sales_amt),0)::bigint AS cost,
           COALESCE(SUM(purchase_cnt),0)::int AS "purchaseCnt",
           COALESCE(SUM(purchase_amt),0)::bigint AS "purchaseAmt"
    FROM stat_campaign_daily WHERE account_id = $1 AND stat_date >= $2 AND stat_date <= $3
    GROUP BY stat_date ORDER BY stat_date
  `, [accountId, since, until]);
}

module.exports = Object.assign(module.exports, {
  initDb, query, get, all,
  createUser, getUserByUsername, getUserById, authenticateUser, countUsers,
  getAllUsers, getPendingUsers, approveUser, rejectUser,
  updateApiCredentials, getApiCredentials, getSmtpCredentials,
  listAgencyCredentials, addAgencyCredential, updateAgencyCredential, deleteAgencyCredential, getAgencyCredentialById,
  getAccountsByUser, getAccountById, getAccountByCustomerId, getAllAccountsWithFeature,
  addSelectedAccount, updateAccount, deleteAccount,
  resetAdminPassword, deleteAllUsers,
  updateSyncStatus, upsertMasterCampaigns, upsertMasterAdgroups, upsertMasterKeywords, upsertMasterQi,
  getMasterCampaigns, getMasterAdgroups, getMasterKeywords, buildKeywordMaps,
  getAutoBidKeywords, upsertAutoBidKeyword, deleteAutoBidKeyword, updateAutoBidKeywordStatus, getEnabledAutoBidKeywords,
  getShoppingBidKeywords, upsertShoppingBidKeyword, deleteShoppingBidKeyword, updateShoppingBidKeywordStatus, getEnabledShoppingBidKeywords,
  isSynced, queryStatsSummary, queryStatsKeywords, queryStatsHourly, queryStatsDevice, queryStatsCampaigns, queryStatsAdgroups, queryStatsTrend,
});
