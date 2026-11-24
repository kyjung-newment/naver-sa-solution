/**
 * 민감정보 암호화 저장 (AES-256-GCM)
 *
 * 대상: 네이버 API 키·시크릿, 다우오피스/SMTP 비밀번호, 전역 발신 비밀번호, DA 쿠키.
 * 저장 형식: enc:v1:<kid>:<iv>:<tag>:<ciphertext> (base64url). enc: 접두어가 없으면 평문으로 보고 그대로 반환한다.
 *
 * 키
 *  - kid 'k': DATA_ENC_KEY 환경변수 (권장, 32바이트 이상 임의 문자열)
 *  - kid 's': SESSION_SECRET에서 HKDF로 파생 (DATA_ENC_KEY가 없을 때). 코드 기본값 시크릿으로는 암호화하지 않는다.
 *
 * 안전장치
 *  - 운영(Vercel)에서만 암호화한다. 로컬 프로세스는 키가 다를 수 있어 평문 그대로 쓰고, 운영 정리 작업이 나중에 암호화한다.
 *  - 키 지문을 system_settings에 기록해, 다른 키를 가진 프로세스가 암호화하지 못하게 한다.
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const DEFAULT_SESSION_SECRET = 'naver-sa-secret-change-me';

function deriveKeys() {
  const keys = {};
  if (process.env.DATA_ENC_KEY && process.env.DATA_ENC_KEY.length >= 32) {
    keys.k = crypto.createHash('sha256').update(process.env.DATA_ENC_KEY).digest();
  }
  const ss = process.env.SESSION_SECRET;
  if (ss && ss !== DEFAULT_SESSION_SECRET && ss.length >= 16) {
    keys.s = Buffer.from(crypto.hkdfSync('sha256', ss, 'naver-sa-solution', 'data-encryption/v1', 32));
  }
  return keys;
}
const KEYS = deriveKeys();
const ACTIVE_KID = KEYS.k ? 'k' : (KEYS.s ? 's' : null);
const fingerprint = kid => (KEYS[kid] ? crypto.createHash('sha256').update(KEYS[kid]).update('fp').digest('hex').slice(0, 16) : null);

// 운영 DB에 기록된 키 지문과 일치할 때만 암호화 (initSecretBox가 설정)
let writeEnabled = false;
let status = { active: false, kid: ACTIVE_KID, reason: '초기화 전' };

const b64 = b => b.toString('base64url');
const isEncrypted = v => typeof v === 'string' && v.startsWith(PREFIX);

function encryptWith(kid, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEYS[kid], iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `${PREFIX}${kid}:${b64(iv)}:${b64(c.getAuthTag())}:${b64(ct)}`;
}

/** 저장 직전에 호출. 암호화가 꺼져 있거나 빈 값이면 그대로 반환 */
function seal(value) {
  if (value == null || value === '' || isEncrypted(value) || !writeEnabled) return value;
  return encryptWith(ACTIVE_KID, value);
}

/** 사용 직전에 호출. 평문은 그대로, 암호문은 복호화. 복호화할 수 없으면 '' (자격증명 오류로 드러나게) */
function open(value) {
  if (!isEncrypted(value)) return value;
  try {
    const [kid, iv, tag, ct] = value.slice(PREFIX.length).split(':');
    if (!KEYS[kid]) throw new Error(`키(${kid}) 없음`);
    const d = crypto.createDecipheriv('aes-256-gcm', KEYS[kid], Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  } catch (e) {
    console.error('🔐 민감정보 복호화 실패 (키 불일치 가능):', e.message);
    return '';
  }
}

/** 객체의 지정 필드를 복호화한 얕은 복사본 */
function openFields(obj, fields) {
  if (!obj) return obj;
  const out = { ...obj };
  for (const f of fields) if (f in out) out[f] = open(out[f]);
  return out;
}

/** 화면 표시용 마스킹 (앞 4자 + 길이 감춤) */
function mask(value, keep = 4) {
  const v = open(value) || '';
  if (!v) return '';
  return v.length <= keep ? '****' : `${v.slice(0, keep)}${'*'.repeat(8)}`;
}

/**
 * 운영 프로세스 시작 시 호출. 키 지문을 확인하고 암호화 쓰기를 켠다.
 * @param pool pg Pool
 */
async function initSecretBox(pool) {
  writeEnabled = false;
  if (!ACTIVE_KID) { status = { active: false, kid: null, reason: '암호화 키 없음 (DATA_ENC_KEY 또는 SESSION_SECRET 필요)' }; return status; }
  if (!process.env.VERCEL && process.env.SECRET_BOX_WRITE !== '1') {
    status = { active: false, kid: ACTIVE_KID, reason: '로컬 실행 — 암호화 쓰기 비활성 (운영에서만 암호화)' };
    return status;
  }
  const key = `enc_key_fp_${ACTIVE_KID}`;
  const fp = fingerprint(ACTIVE_KID);
  await pool.query(`INSERT INTO system_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, fp]);
  const stored = await pool.query(`SELECT value FROM system_settings WHERE key = $1`, [key]).then(r => r.rows[0]?.value);
  if (stored !== fp) {
    status = { active: false, kid: ACTIVE_KID, reason: '키 지문 불일치 — 이 프로세스는 운영과 다른 키를 사용 중이라 암호화하지 않습니다' };
    console.error(`🔐 ${status.reason}`);
    return status;
  }
  writeEnabled = true;
  status = { active: true, kid: ACTIVE_KID, reason: ACTIVE_KID === 'k' ? 'DATA_ENC_KEY 사용' : 'SESSION_SECRET 파생 키 사용 (DATA_ENC_KEY 설정 권장)' };
  return status;
}

// 암호화 대상 컬럼 (표 · 키 컬럼 · 대상 컬럼)
const TARGETS = [
  { table: 'users', id: 'id', cols: ['api_key', 'secret_key', 'smtp_pass'] },
  { table: 'agency_credentials', id: 'id', cols: ['api_key', 'secret_key'] },
  { table: 'ad_accounts', id: 'id', cols: ['email_pass', 'naver_cookie'] },
];

/** 평문으로 남은 값을 암호화 (멱등). 반환: 암호화한 값 개수 */
async function sealPlaintextRows(pool) {
  if (!writeEnabled) return 0;
  let n = 0;
  for (const t of TARGETS) {
    for (const col of t.cols) {
      const rows = await pool.query(
        `SELECT ${t.id} AS id, ${col} AS v FROM ${t.table} WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} NOT LIKE 'enc:v1:%'`
      ).then(r => r.rows).catch(() => []);
      for (const r of rows) {
        // 조건부 UPDATE: 그 사이 다른 값으로 바뀌었으면 건드리지 않는다
        const u = await pool.query(`UPDATE ${t.table} SET ${col} = $1 WHERE ${t.id} = $2 AND ${col} = $3`, [seal(r.v), r.id, r.v]).catch(() => ({ rowCount: 0 }));
        n += u.rowCount;
      }
    }
  }
  const g = await pool.query(`SELECT value FROM system_settings WHERE key = 'global_smtp_pass'`).then(r => r.rows[0]?.value).catch(() => null);
  if (g && !isEncrypted(g)) {
    const u = await pool.query(`UPDATE system_settings SET value = $1 WHERE key = 'global_smtp_pass' AND value = $2`, [seal(g), g]).catch(() => ({ rowCount: 0 }));
    n += u.rowCount;
  }
  if (n) console.log(`🔐 평문 민감정보 ${n}건 암호화`);
  return n;
}

/** 관리자 화면용 현황: 컬럼별 암호화/평문 개수 */
async function coverageReport(pool) {
  const out = [];
  for (const t of TARGETS) {
    for (const col of t.cols) {
      const r = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE ${col} LIKE 'enc:v1:%')::int AS enc,
                COUNT(*) FILTER (WHERE ${col} IS NOT NULL AND ${col} <> '' AND ${col} NOT LIKE 'enc:v1:%')::int AS plain
         FROM ${t.table}`).then(x => x.rows[0]).catch(() => ({ enc: 0, plain: 0 }));
      out.push({ target: `${t.table}.${col}`, ...r });
    }
  }
  return out;
}

/** 운영 자가검증: 암호화된 값을 표본으로 복호화해 키가 맞는지 확인 (값은 반환하지 않음) */
async function selfCheck(pool, sample = 30) {
  const rows = await pool.query(
    `SELECT v FROM (
       SELECT secret_key AS v FROM users WHERE secret_key LIKE 'enc:v1:%'
       UNION ALL SELECT secret_key FROM agency_credentials WHERE secret_key LIKE 'enc:v1:%'
       UNION ALL SELECT smtp_pass FROM users WHERE smtp_pass LIKE 'enc:v1:%'
     ) x LIMIT $1`, [sample]).then(r => r.rows).catch(() => []);
  let failed = 0;
  for (const r of rows) {
    const [kid, iv, tag, ct] = r.v.slice(PREFIX.length).split(':');
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', KEYS[kid], Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
    } catch (_) { failed++; }
  }
  return { checked: rows.length, failed };
}

module.exports = {
  seal, open, openFields, mask, isEncrypted, initSecretBox, sealPlaintextRows, coverageReport, selfCheck,
  getStatus: () => ({ ...status, fingerprint: ACTIVE_KID ? fingerprint(ACTIVE_KID) : null, hasDataKey: !!KEYS.k, hasSessionKey: !!KEYS.s }),
};
