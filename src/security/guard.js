/**
 * 1차(접근 차단) · 3차(감시·추적) 보안 계층
 *  - 보안 헤더 + 로그인 사용자 응답 캐시 금지
 *  - 로그인·비밀번호 재설정 시도 제한 (DB 기반이라 서버리스 인스턴스 간에도 공유)
 *  - 감사 로그: 로그인, 비밀번호·자격증명 변경, 개인정보가 담긴 리포트 내려받기, 권한·계정 변경
 *  - 이상 징후 관리자 알림: 계정 잠금, 짧은 시간 대량 다운로드
 */
const crypto = require('crypto');

let pool = null;
let alertFn = null; // async (subject, html) => void — 관리자 알림 메일

// ─── 공통 ───────────────────────────────────────────────────────
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.headers['x-real-ip'] || req.socket?.remoteAddress || '').toString().slice(0, 64);
}
const maskEmail = e => {
  const [l, d] = String(e || '').split('@');
  if (!d) return e ? '***' : '';
  return `${l.slice(0, 2)}${'*'.repeat(Math.max(2, l.length - 2))}@${d}`;
};
const maskEmails = list => String(list || '').split(',').map(s => maskEmail(s.trim())).filter(Boolean).join(', ');

async function ensureSchema(p) {
  pool = p;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_audit_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER,
      username TEXT DEFAULT '',
      role TEXT DEFAULT '',
      event TEXT NOT NULL,
      ok BOOLEAN DEFAULT TRUE,
      ip TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      method TEXT DEFAULT '',
      path TEXT DEFAULT '',
      target TEXT DEFAULT '',
      detail TEXT DEFAULT ''
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS security_audit_log_created ON security_audit_log (created_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS security_audit_log_event ON security_audit_log (event, created_at DESC)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_throttle (
      key TEXT PRIMARY KEY,
      fails INTEGER DEFAULT 0,
      window_start TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      locked_until TIMESTAMP
    )`);
}

function setAlert(fn) { alertFn = fn; }

// ─── 감사 로그 ──────────────────────────────────────────────────
async function audit(req, event, { ok = true, target = '', detail = '', userId, username } = {}) {
  if (!pool) return;
  const s = req?.session || {};
  try {
    await pool.query(
      `INSERT INTO security_audit_log (user_id, username, role, event, ok, ip, user_agent, method, path, target, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [userId ?? s.userId ?? null, String(username ?? s.userName ?? '').slice(0, 100), String(s.role || (s.isAdmin ? 'admin' : '')).slice(0, 20),
        event, ok, req ? clientIp(req) : '', String(req?.headers?.['user-agent'] || '').slice(0, 200),
        req?.method || '', String(req?.originalUrl || '').split('?')[0].slice(0, 200), String(target).slice(0, 200), String(detail).slice(0, 500)]);
  } catch (e) { console.warn('감사 로그 기록 실패:', e.message); }
}

// 자동 기록 대상: 개인정보가 담긴 내려받기·조회 + 모든 변경 요청
const EXPORT_PATTERNS = [
  [/\/api\/report\/download-excel$/, 'export_report_excel'],
  [/\/api\/report\/preview$/, 'view_report_preview'],
  [/\/api\/report\/one-click-excel$/, 'export_analysis_excel'],
  [/\/api\/da-upload\/excel$/, 'export_da_excel'],
  [/\/api\/da-upload\/preview$/, 'view_da_preview'],
  [/\/api\/da-report\/download-excel$/, 'export_da_excel'],
  [/\/strategy\/.*excel/, 'export_strategy_excel'],
  [/\/admin\/accounts\/template$/, 'export_account_template'],
  [/\/api\/admin\/reveal-reset-secret$/, 'reveal_reset_secret'],
];
const SKIP_MUTATION = [/\/api\/select-account$/, /\/api\/cron\//, /\/login$/, /\/logout$/, /\/api\/reset-password\//, /\/reset-password$/];

function auditMiddleware(req, res, next) {
  const path = (req.originalUrl || '').split('?')[0];
  let event = null;
  for (const [re, ev] of EXPORT_PATTERNS) if (re.test(path)) { event = ev; break; }
  if (!event && req.method !== 'GET' && req.method !== 'HEAD' && req.session?.userId && !SKIP_MUTATION.some(re => re.test(path))) event = 'change';
  if (!event) return next();
  res.on('finish', () => {
    const q = req.query || {};
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const target = [q.accountId || b.accountId || req.params?.id || '', q.type || b.type || '', q.mode || b.mode || ''].filter(Boolean).join(' ');
    audit(req, event, { ok: res.statusCode < 400, target, detail: `HTTP ${res.statusCode}` });
    if (event.startsWith('export_')) watchExports(req).catch(() => {});
  });
  next();
}

// 1시간에 내려받기 30회 이상 → 관리자 알림 (사용자별 1시간 1회)
async function watchExports(req) {
  const uid = req.session?.userId;
  if (!uid || !pool) return;
  const n = await pool.query(`SELECT COUNT(*)::int c FROM security_audit_log WHERE user_id = $1 AND event LIKE 'export_%' AND created_at > NOW() - INTERVAL '1 hour'`, [uid]).then(r => r.rows[0].c);
  if (n < 30) return;
  await notify(`[보안] 대량 리포트 내려받기 감지 — ${req.session.userName || uid}`,
    `<p><b>${esc(req.session.userName || uid)}</b> 계정이 최근 1시간 동안 리포트를 <b>${n}회</b> 내려받았습니다.</p><p>IP: ${esc(clientIp(req))}</p><p>정상 업무가 아니라면 관리자 → 보안 점검에서 확인 후 계정을 정지하세요.</p>`, `export:${uid}`);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 같은 사안(dedupeKey)은 1시간에 1번만 알림 (서버리스 인스턴스 간에도 감사 로그로 중복 확인)
async function notify(subject, html, dedupeKey) {
  if (!alertFn) return;
  const key = String(dedupeKey || subject).slice(0, 200);
  try {
    if (pool) {
      const dup = await pool.query(`SELECT 1 FROM security_audit_log WHERE event = 'security_alert' AND target = $1 AND created_at > NOW() - INTERVAL '1 hour' LIMIT 1`, [key]).then(r => r.rows.length > 0).catch(() => false);
      if (dup) return;
    }
    await audit(null, 'security_alert', { target: key, detail: subject });
    await alertFn(subject, html);
  } catch (e) { console.warn('보안 알림 발송 실패:', e.message); }
}

// ─── 시도 제한 ──────────────────────────────────────────────────
// 정책: 키별로 window 분 안에 max회 실패하면 lock 분 동안 차단
const POLICIES = {
  login_user: { max: 5, window: 15, lock: 15 },
  login_ip: { max: 20, window: 15, lock: 30 },
  reset_ip: { max: 10, window: 15, lock: 30 },
  secret_ip: { max: 5, window: 60, lock: 60 },
};
const throttleKey = (kind, v) => `${kind}:${crypto.createHash('sha256').update(String(v).toLowerCase()).digest('hex').slice(0, 32)}`;

/** 잠겨 있으면 남은 분, 아니면 0 */
async function lockedMinutes(kind, v) {
  if (!pool || !v) return 0;
  const r = await pool.query(`SELECT EXTRACT(EPOCH FROM (locked_until - NOW()))::int AS s FROM login_throttle WHERE key = $1 AND locked_until > NOW()`, [throttleKey(kind, v)])
    .then(x => x.rows[0]).catch(() => null);
  return r ? Math.max(1, Math.ceil(r.s / 60)) : 0;
}

/** 실패 1회 기록. 이번 실패로 잠기면 true */
async function recordFailure(kind, v) {
  if (!pool || !v) return false;
  const p = POLICIES[kind];
  const key = throttleKey(kind, v);
  const r = await pool.query(`
    INSERT INTO login_throttle (key, fails, window_start) VALUES ($1, 1, NOW())
    ON CONFLICT (key) DO UPDATE SET
      fails = CASE WHEN login_throttle.window_start < NOW() - ($2 || ' minutes')::interval THEN 1 ELSE login_throttle.fails + 1 END,
      window_start = CASE WHEN login_throttle.window_start < NOW() - ($2 || ' minutes')::interval THEN NOW() ELSE login_throttle.window_start END
    RETURNING fails`, [key, String(p.window)]).then(x => x.rows[0]).catch(() => null);
  if (r && r.fails >= p.max) {
    await pool.query(`UPDATE login_throttle SET locked_until = NOW() + ($2 || ' minutes')::interval, fails = 0, window_start = NOW() WHERE key = $1`, [key, String(p.lock)]).catch(() => {});
    return true;
  }
  return false;
}
async function clearFailures(kind, v) {
  if (!pool || !v) return;
  await pool.query(`DELETE FROM login_throttle WHERE key = $1`, [throttleKey(kind, v)]).catch(() => {});
}
async function unlockAll() {
  if (!pool) return 0;
  return pool.query(`DELETE FROM login_throttle`).then(r => r.rowCount).catch(() => 0);
}
async function activeLocks() {
  if (!pool) return [];
  return pool.query(`SELECT split_part(key, ':', 1) AS kind, locked_until::text AS locked_until FROM login_throttle WHERE locked_until > NOW() ORDER BY locked_until DESC`)
    .then(r => r.rows).catch(() => []);
}

// ─── 보안 헤더 ──────────────────────────────────────────────────
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'");
  if (process.env.VERCEL) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
}
// 로그인 사용자 화면·데이터는 브라우저·프록시에 캐시하지 않는다 (공용 PC 뒤로가기 노출 방지)
function noStoreForSession(req, res, next) {
  if (req.session?.userId) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
}

// API JSON 응답의 문자열에서 < > 를 비슷한 모양의 문자로 바꾼다.
// 네이버 캠페인명·광고주명처럼 외부에서 들어온 값이 화면 스크립트에서 innerHTML로 그려질 때 태그로 해석되지 않게 하는 방어선.
function sanitizeDeep(v, depth = 0) {
  if (typeof v === 'string') return v.indexOf('<') === -1 && v.indexOf('>') === -1 ? v : v.replace(/</g, '‹').replace(/>/g, '›');
  if (!v || typeof v !== 'object' || depth > 12 || Buffer.isBuffer(v) || v instanceof Date) return v;
  if (Array.isArray(v)) return v.map(x => sanitizeDeep(x, depth + 1));
  const out = {};
  for (const k of Object.keys(v)) out[k] = sanitizeDeep(v[k], depth + 1);
  return out;
}
function jsonSanitizer(req, res, next) {
  const orig = res.json.bind(res);
  res.json = body => orig(sanitizeDeep(body));
  next();
}

// ─── 보존기간 정리 ──────────────────────────────────────────────
async function cleanup() {
  if (!pool) return;
  await pool.query(`DELETE FROM security_audit_log WHERE created_at < NOW() - INTERVAL '400 days'`).catch(() => {});
  await pool.query(`DELETE FROM login_throttle WHERE (locked_until IS NULL OR locked_until < NOW()) AND window_start < NOW() - INTERVAL '1 day'`).catch(() => {});
}

module.exports = {
  ensureSchema, setAlert, audit, auditMiddleware, notify, clientIp, maskEmail, maskEmails,
  lockedMinutes, recordFailure, clearFailures, unlockAll, activeLocks, securityHeaders, noStoreForSession, cleanup, POLICIES, jsonSanitizer, sanitizeDeep,
};
