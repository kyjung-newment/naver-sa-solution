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
    'INSERT INTO users (username, password_hash, name, is_admin, approved) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [username, passwordHash, name, isAdmin ? 1 : 0, approved ? 1 : 0]
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
  return query('DELETE FROM users WHERE id = $1 AND is_admin = 0', [userId]);
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

module.exports = Object.assign(module.exports, {
  initDb,
  createUser, getUserByUsername, getUserById, authenticateUser, countUsers,
  getAllUsers, getPendingUsers, approveUser, rejectUser,
  updateApiCredentials, getApiCredentials,
  getAccountsByUser, getAccountById, getAccountByCustomerId, getAllAccountsWithFeature,
  addSelectedAccount, updateAccount, deleteAccount,
});
