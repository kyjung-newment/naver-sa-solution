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
  await pool.query(`
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

  await pool.query(`
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
  await pool.query(`
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

  await pool.query(`
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

  await pool.query(`
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

  // ad_accounts에 동기화 상태 컬럼 추가
  try {
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS sync_status TEXT DEFAULT 'none'`);
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP`);
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS campaign_count INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS adgroup_count INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS keyword_count INTEGER DEFAULT 0`);
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_daily_report TIMESTAMP`);
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_weekly_report TIMESTAMP`);
    await pool.query(`ALTER TABLE ad_accounts ADD COLUMN IF NOT EXISTS last_monthly_report TIMESTAMP`);
  } catch (e) { /* 이미 존재하면 무시 */ }

  // users에 SMTP 비밀번호 컬럼 추가 (다우오피스 연동용)
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS smtp_pass TEXT DEFAULT ''`);
  } catch (e) { /* 이미 존재하면 무시 */ }

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
async function createUser(username, password, name, { isAdmin = 0, approved = 0 } = {}) {
  const passwordHash = hashPassword(password);
  const result = await pool.query(
    'INSERT INTO users (username, password_hash, name, is_admin, approved, smtp_pass) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [username, passwordHash, name, isAdmin ? 1 : 0, approved ? 1 : 0, password]
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
  // 로그인 시 SMTP 비밀번호 갱신 (비밀번호 변경 대비)
  await pool.query('UPDATE users SET smtp_pass = $1 WHERE id = $2', [password, user.id]).catch(() => {});
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
  return query('DELETE FROM users WHERE id = $1 AND is_admin = 0', [userId]);
}

// ─── SMTP 자격증명 (다우오피스 자동 연동) ──────────────────────────────
async function getSmtpCredentials(userId) {
  return get('SELECT username, smtp_pass FROM users WHERE id = $1', [userId]);
}

// ─── API 자격증명 ─────────────────────────────────────────────────────
async function updateApiCredentials(userId, apiKey, secretKey, managerCustomerId) {
  return query(
    'UPDATE users SET api_key = $1, secret_key = $2, manager_customer_id = $3 WHERE id = $4',
    [apiKey, secretKey, managerCustomerId, userId]
  );
}

async function getApiCredentials(userId) {
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
  return all(`
    SELECT ad_accounts.*,
           users.name AS user_name,
           users.api_key,
           users.secret_key,
           users.manager_customer_id
    FROM ad_accounts
    JOIN users ON users.id = ad_accounts.user_id
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
      auto_bid_min_bid = $14, auto_bid_interval = $15
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
  for (const r of rows) {
    await pool.query(
      `INSERT INTO master_campaigns (account_id, customer_id, campaign_id, campaign_name, campaign_tp, delivery_method, use_daily_budget, reg_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [accountId, r[0], r[1], r[2], parseInt(r[3]) || 1, parseInt(r[4]) || 1, parseInt(r[5]) || 0, r[8] || '']
    );
  }
}

async function upsertMasterAdgroups(accountId, rows) {
  await pool.query('DELETE FROM master_adgroups WHERE account_id = $1', [accountId]);
  for (const r of rows) {
    await pool.query(
      `INSERT INTO master_adgroups (account_id, customer_id, adgroup_id, adgroup_name, campaign_id, use_daily_budget, reg_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, r[0], r[1], r[2], r[3] || '', parseInt(r[4]) || 0, r[7] || '']
    );
  }
}

async function upsertMasterKeywords(accountId, rows) {
  await pool.query('DELETE FROM master_keywords WHERE account_id = $1', [accountId]);
  for (const r of rows) {
    await pool.query(
      `INSERT INTO master_keywords (account_id, customer_id, keyword_id, keyword, adgroup_id, bid_amt, use_group_bid, status, reg_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [accountId, r[0], r[1], r[2] || '', r[3] || '', parseInt(r[4]) || 0, parseInt(r[5]) || 0, r[6] || '', r[7] || '']
    );
  }
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
    };
  }

  return { campMap, agMap, kwMap };
}

module.exports = Object.assign(module.exports, {
  initDb,
  createUser, getUserByUsername, getUserById, authenticateUser, countUsers,
  getAllUsers, getPendingUsers, approveUser, rejectUser,
  updateApiCredentials, getApiCredentials, getSmtpCredentials,
  getAccountsByUser, getAccountById, getAccountByCustomerId, getAllAccountsWithFeature,
  addSelectedAccount, updateAccount, deleteAccount,
  resetAdminPassword, deleteAllUsers,
  updateSyncStatus, upsertMasterCampaigns, upsertMasterAdgroups, upsertMasterKeywords,
  getMasterCampaigns, getMasterAdgroups, getMasterKeywords, buildKeywordMaps,
});
