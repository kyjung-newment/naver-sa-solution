// ═══════════════════════════════════════════════════════════════════
//  네이버SA 입찰 자동 조정 웹앱 (팩토리 — /egojin-bid 전용 + /auto-bid 멀티 브랜드)
//  쇼핑검색 소재 입찰가 주기 자동 조정·관리 (데스크톱 우선 UI)
//  역할: master(마스터=마케터·마스터 초대 계정, 전체 설정/실행/승인)
//       / client(광고주, 조회+승인, 설정은 열람만)
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');
const { config } = require('../../config');
const db = require('../db/database');
const { createApiClient } = require('../api/naverApi');
const rawBidDb = require('./db');
const logic = require('./logic');
const rawEngine = require('./engine');
const rawCollector = require('./collector');
const { sendInviteEmail } = require('../email/sender');

// ─── 채널 바인딩 래퍼 ───────────────────────────────────────────────
// 팩토리 인스턴스의 채널(shopping/powerlink)을 DAO·엔진·수집기 호출에 자동 주입한다.
// (라우트 코드는 채널을 모른 채 bidDb/engine/collector 를 그대로 사용)
function channelDb(ch) {
  return {
    ...rawBidDb,
    getSettings: (a) => rawBidDb.getSettings(a, ch),
    setSetting: (a, k, v, by) => rawBidDb.setSetting(a, k, v, by, ch),
    getSettingHistory: (a, l) => rawBidDb.getSettingHistory(a, l, ch),
    getCategoryRules: (a) => rawBidDb.getCategoryRules(a, ch),
    setCategoryRule: (a, c, r, by) => rawBidDb.setCategoryRule(a, c, r, by, ch),
    getMaterials: (a, o = {}) => rawBidDb.getMaterials(a, { ...o, channel: ch }),
    getAdjustments: (a, o = {}) => rawBidDb.getAdjustments(a, { ...o, channel: ch }),
    getAlerts: (a, o = {}) => rawBidDb.getAlerts(a, { ...o, channel: ch }),
    getMonthlyReports: (a, l) => rawBidDb.getMonthlyReports(a, l, ch),
  };
}
function channelEngine(ch) {
  return {
    ...rawEngine,
    computeWeekly: (a, o = {}) => rawEngine.computeWeekly(a, { ...o, channel: ch }),
    runWeekly: (a, c, o = {}) => rawEngine.runWeekly(a, c, { ...o, channel: ch }),
    computeBaselines: (a, o = {}) => rawEngine.computeBaselines(a, { ...o, channel: ch }),
    runDailyMonitor: (a, c, d) => rawEngine.runDailyMonitor(a, c, d, ch),
    runMonthlyReport: (a, m) => rawEngine.runMonthlyReport(a, m, ch),
    createManualAdjustment: (a, id, r, o = {}) => rawEngine.createManualAdjustment(a, id, r, { ...o, channel: ch }),
  };
}
function channelCollector(ch) {
  return {
    ...rawCollector,
    syncMaterials: (a, c) => rawCollector.syncMaterials(a, c, ch),
    collectWeeklyStats: (a, c, o = {}) => rawCollector.collectWeeklyStats(a, c, { ...o, channel: ch }),
  };
}

// ─── 앱 팩토리 ──────────────────────────────────────────────────────
// 같은 코드로 두 종류의 인스턴스를 만든다:
//  - 전용(pinnedCustomerId 지정): 특정 광고주 고정 (예: /egojin-bid = 이고진 242566)
//  - 범용(pinnedCustomerId null): 멀티 브랜드 — 광고주 선택·추가 가능 (예: /auto-bid)
// 데이터(테이블)는 account_id 기준으로 공유되므로 두 URL이 같은 광고주를 함께 관리할 수 있다.
function createBidApp(appConfig) {
const BASE = appConfig.base;
const APP_NAME = appConfig.appName;
const APP_SUBTITLE = appConfig.appSubtitle || 'Naver SA Auto Bidding';
const PINNED_CUSTOMER_ID = appConfig.pinnedCustomerId || null;
const PINNED_LABEL = appConfig.pinnedLabel || '';
// 채널: shopping(쇼핑검색 소재) | powerlink(파워링크 키워드) — 조정 단위·데이터·설정이 채널별 분리
const CHANNEL = appConfig.channel || 'shopping';
const UNIT = CHANNEL === 'powerlink' ? '키워드' : '소재';
const bidDb = channelDb(CHANNEL);
const engine = channelEngine(CHANNEL);
const collector = channelCollector(CHANNEL);
const router = express.Router();

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = (n) => (n == null ? '-' : Math.round(n).toLocaleString('ko-KR'));
const fmtRoas = (r) => (r == null ? '-' : (r * 100).toFixed(0) + '%');
const wkKey = (w) => (w instanceof Date) ? w.toISOString().slice(0, 10) : String(w).slice(0, 10);

// ─── 세션 (기존 솔루션과 동일 스토어·쿠키 공유 → SSO) ───────────────
router.use(session({
  store: new pgSession({ pool: db.pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  proxy: true,
  cookie: { maxAge: 8 * 60 * 60 * 1000, sameSite: 'lax', secure: !!process.env.VERCEL, httpOnly: true },
}));
router.use(express.json({ limit: '2mb' }));
router.use(express.urlencoded({ extended: true, limit: '2mb' }));

// ─── 권한 (역할 2종: master=마스터 / client=광고주) ─────────────────
// 초대 계정(users.role='viewer')은 account_viewers.role 로 마스터/광고주 구분.
// 뉴먼트 솔루션 계정(마케터)은 항상 마스터. (기존 admin → 마스터 자동 이관)
function isInvited(req) { return req.session.role === 'viewer'; }
function isClient(req) {
  if (req.session.bidRole) return req.session.bidRole === 'client';
  return isInvited(req); // 미해석 시 폴백: 초대 계정=광고주
}

async function resolveBidRole(req) {
  if (!req.session.userId) return null;
  if (!isInvited(req)) { req.session.bidRole = 'master'; return 'master'; }
  const master = await bidDb.isInvitedMaster(req.session.userId);
  req.session.bidRole = master ? 'master' : 'client';
  return req.session.bidRole;
}

// SSO(기존 솔루션과 세션 공유)로 들어온 세션도 최초 요청 시 역할 해석
router.use(async (req, res, next) => {
  try {
    if (req.session.userId && !req.session.bidRole) await resolveBidRole(req);
  } catch (e) { /* 역할 해석 실패 → 폴백 규칙 사용 */ }
  next();
});

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect(`${BASE}/login`);
  if ((req.session.approved === 0 || req.session.approved === -1)) return res.redirect('/smart-sa/pending');
  next();
}

const forbidden = () => `<div style="font-family:Pretendard,system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;padding:30px"><div style="font-size:40px;margin-bottom:8px">🔒</div><h2 style="color:#111827;margin-bottom:8px">접근 권한이 없습니다</h2><p style="color:#6b7280;margin:0 0 20px;font-size:14px">광고주 계정은 조회·승인 기능만 이용할 수 있습니다. (설정은 열람만 가능)</p><a href="${BASE}" style="color:#0ea5e9;font-weight:600">← 대시보드로 돌아가기</a></div>`;

// 광고주(client) 허용 경로 — 그 외 전면 차단 (default deny)
// 설정은 GET(열람)만 허용 — 저장 API(POST /api/settings/*)는 차단되어 403
function clientPathAllowed(p, method) {
  if (['/', '/login', '/logout', '/weekly', '/approvals', '/history'].includes(p)) return true;
  if (method === 'GET' && p === '/settings') return true;
  if (p.startsWith('/invite')) return true;
  if (p === '/api/select-account') return true;
  if (method === 'GET' && (p === '/api/weekly' || p === '/api/history' || p === '/api/material-trend')) return true;
  if (method === 'POST' && p.startsWith('/api/approvals/')) return true; // 승인/반려
  return false;
}
router.use((req, res, next) => {
  if (!isClient(req)) return next();
  if (clientPathAllowed(req.path, req.method)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: '권한 없음 (광고주 계정)' });
  return res.status(403).send(forbidden());
});

function requireMaster(req, res, next) {
  if (isClient(req)) {
    if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: '권한 없음 (광고주 계정)' });
    return res.status(403).send(forbidden());
  }
  next();
}

// ─── 계정 해석 ─────────────────────────────────────────────────────
async function getUser(req) {
  return db.getUserById(req.session.userId);
}

// 접근 가능한 광고주 목록
// - 전용 앱(PINNED): 고정 광고주만 (마스터는 누가 연동했든 공유, 입찰 데이터가 붙은 계정 행 우선)
// - 범용 앱(멀티 브랜드): 광고주(client)=초대받은 계정 / 마스터=본인 소유 + 초대 + 입찰관리 연동 광고주 전체 공유
async function getAccessibleAccounts(req) {
  if (isClient(req)) {
    const viewer = await db.getViewerAccounts(req.session.userId);
    return PINNED_CUSTOMER_ID ? viewer.filter(a => String(a.customer_id) === PINNED_CUSTOMER_ID) : viewer;
  }
  if (PINNED_CUSTOMER_ID) {
    return (await bidDb.pool.query(`
      SELECT a.*,
        (EXISTS (SELECT 1 FROM bid_materials m WHERE m.account_id = a.id))::int
        + (EXISTS (SELECT 1 FROM bid_settings s WHERE s.account_id = a.id))::int AS bid_weight
      FROM ad_accounts a
      WHERE a.customer_id = $1
      ORDER BY bid_weight DESC, a.id ASC
    `, [PINNED_CUSTOMER_ID])).rows;
  }
  // 멀티 브랜드: 본인 소유 + 초대받은 계정 + 입찰관리 데이터가 있는 광고주 전체 (마스터 간 공유)
  const viewer = isInvited(req) ? await db.getViewerAccounts(req.session.userId) : [];
  const owned = await db.getAccountsByUser(req.session.userId);
  const shared = (await bidDb.pool.query(`
    SELECT DISTINCT a.* FROM ad_accounts a
    WHERE EXISTS (SELECT 1 FROM bid_materials m WHERE m.account_id = a.id)
       OR EXISTS (SELECT 1 FROM bid_settings s WHERE s.account_id = a.id)
  `)).rows;
  const seen = new Set(); const out = [];
  for (const a of [...viewer, ...owned, ...shared]) {
    if (seen.has(String(a.id))) continue;
    seen.add(String(a.id)); out.push(a);
  }
  return out.sort((x, y) => String(x.name).localeCompare(String(y.name), 'ko'));
}

// 앱별 선택 광고주 세션 키 (전용/범용 앱이 서로의 선택을 덮지 않도록 분리)
const SEL_KEY = 'bidAcct_' + BASE.replace(/[^a-z0-9]/gi, '');

async function getSelectedAccount(req) {
  const accounts = await getAccessibleAccounts(req);
  if (!accounts.length) return { accounts, account: null };
  if (PINNED_CUSTOMER_ID) {
    // 고정 광고주: 항상 첫 번째(입찰 데이터가 붙은) 계정 행 사용
    return { accounts, account: accounts[0] };
  }
  let account = accounts.find(a => String(a.id) === String(req.session[SEL_KEY] || ''));
  if (!account) { account = accounts[0]; req.session[SEL_KEY] = account.id; }
  return { accounts, account };
}

async function getCreds(req, accountId) {
  // 마스터는 공유 계정(다른 마스터가 연동한 광고주)도 소유자 자격증명으로 자동 해석
  if (accountId && !isClient(req)) {
    const owner = await resolveOwnerCreds(accountId);
    if (owner) return owner;
  }
  const creds = await db.getApiCredentials(req.session.userId, accountId);
  if (!creds) return null;
  return creds;
}

// 광고주 소유자의 자격증명 해석: 계정 연결 credential → 소유자 첫 credential → 소유자 users 레거시
async function resolveOwnerCreds(accountId) {
  const acc = (await bidDb.pool.query('SELECT user_id, agency_credential_id FROM ad_accounts WHERE id = $1', [accountId])).rows[0];
  if (!acc) return null;
  if (acc.agency_credential_id) {
    const linked = (await bidDb.pool.query(
      `SELECT id, api_key, secret_key, manager_customer_id FROM agency_credentials WHERE id = $1 AND api_key != ''`,
      [acc.agency_credential_id])).rows[0];
    if (linked) return linked;
  }
  const first = (await bidDb.pool.query(
    `SELECT id, api_key, secret_key, manager_customer_id FROM agency_credentials WHERE user_id = $1 AND api_key != '' ORDER BY id ASC LIMIT 1`,
    [acc.user_id])).rows[0];
  if (first) return first;
  const legacy = (await bidDb.pool.query(
    `SELECT api_key, secret_key, manager_customer_id FROM users WHERE id = $1 AND api_key != ''`,
    [acc.user_id])).rows[0];
  return legacy || null;
}

// ─── 공통 레이아웃 ─────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Pretendard:wght@300;400;500;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Pretendard','Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#f6f8fa;color:#1e293b;font-size:14px}
  a{text-decoration:none;color:inherit}
  input,select,textarea{padding:9px 12px;border:1px solid #e5e7eb;border-radius:9px;font-size:13.5px;width:100%;background:#fff;outline:none;font-family:inherit}
  input:focus,select:focus{border-color:#0ea5e9;box-shadow:0 0 0 3px rgba(14,165,233,.12)}
  label{display:block;font-size:12px;font-weight:600;color:#6b7280;margin-bottom:6px}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:9px;border:none;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .15s}
  .btn-primary{background:#0ea5e9;color:#fff}.btn-primary:hover{background:#0284c7}
  .btn-danger{background:#ef4444;color:#fff}.btn-danger:hover{background:#dc2626}
  .btn-green{background:#10b981;color:#fff}.btn-green:hover{background:#059669}
  .btn-outline{background:#fff;color:#374151;border:1px solid #e5e7eb}.btn-outline:hover{background:#f9fafb}
  .btn-sm{padding:6px 12px;font-size:12px}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .card{background:#fff;border-radius:14px;box-shadow:0 1px 3px rgba(0,0,0,.05);overflow:hidden;margin-bottom:16px}
  .card-header{padding:15px 20px;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
  .card-title{font-size:14.5px;font-weight:700;color:#111827}
  .card-body{padding:20px}
  table{width:100%;border-collapse:collapse}
  th{padding:10px 12px;text-align:left;font-size:11px;color:#94a3b8;font-weight:700;background:#f8fafc;border-bottom:1px solid #eef2f7;white-space:nowrap;position:sticky;top:0;z-index:1}
  td{padding:10px 12px;border-bottom:1px solid #f8fafc;font-size:12.5px;color:#334155;font-variant-numeric:tabular-nums}
  tr:hover td{background:#f7fbfe}
  th.num,td.num{text-align:right}
  .badge{display:inline-flex;padding:3px 9px;border-radius:99px;font-size:11px;font-weight:700;white-space:nowrap}
  .b-up{background:#ecfdf5;color:#059669}.b-down{background:#fef2f2;color:#dc2626}
  .b-keep{background:#f3f4f6;color:#6b7280}.b-warn{background:#fffbeb;color:#b45309}
  .b-blue{background:#eff6ff;color:#2563eb}.b-core{background:#fdf4ff;color:#a21caf}
  .alert{padding:12px 16px;border-radius:10px;margin-bottom:14px;font-size:13px;font-weight:500}
  .alert-err{background:#fef2f2;color:#dc2626;border:1px solid #fecaca}
  .alert-ok{background:#ecfdf5;color:#059669;border:1px solid #a7f3d0}
  .alert-info{background:#f0f9ff;color:#0369a1;border:1px solid #bae6fd}
  .sidebar{width:250px;min-height:100vh;background:#0f172a;position:fixed;top:0;left:0;display:flex;flex-direction:column;z-index:200}
  .sb-head{padding:22px 22px 16px;border-bottom:1px solid #1e293b}
  .sb-logo{font-size:16px;font-weight:800;color:#fff;letter-spacing:-.01em}
  .sb-sub{font-size:11px;color:#64748b;margin-top:3px}
  .sb-link{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:9px;font-size:13px;font-weight:500;color:#94a3b8;margin:2px 10px}
  .sb-link:hover{background:#1e293b;color:#e2e8f0}
  .sb-link.active{background:#0ea5e9;color:#fff;font-weight:700}
  .sb-section{padding:16px 20px 6px;font-size:10px;color:#475569;text-transform:uppercase;letter-spacing:.1em;font-weight:700}
  .sb-foot{margin-top:auto;padding:14px;border-top:1px solid #1e293b}
  .main{margin-left:250px;min-height:100vh}
  .topbar{background:#fff;border-bottom:1px solid #eef2f7;padding:0 26px;height:54px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
  .topbar-title{font-size:16px;font-weight:800;color:#111827}
  .topbar-acct{font-size:12px;color:#475569;background:#f1f5f9;border-radius:99px;padding:5px 14px;font-weight:600}
  .content{padding:24px 26px}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
  @media(max-width:1100px){.kpis{grid-template-columns:repeat(2,1fr)}}
  .kpi{background:#fff;border-radius:14px;padding:18px 20px;box-shadow:0 1px 3px rgba(0,0,0,.05);border-top:3px solid #0ea5e9}
  .kpi.g{border-top-color:#10b981}.kpi.r{border-top-color:#ef4444}.kpi.p{border-top-color:#8b5cf6}.kpi.o{border-top-color:#f59e0b}
  .kpi-l{font-size:11.5px;color:#94a3b8;font-weight:600;margin-bottom:8px}
  .kpi-v{font-size:23px;font-weight:800;color:#0f172a;letter-spacing:-.02em}
  .kpi-s{font-size:11px;color:#94a3b8;margin-top:5px}
  .tbl-wrap{overflow:auto;max-height:640px;border:1px solid #eef2f7;border-radius:12px;background:#fff}
  .toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
  .toolbar select,.toolbar input{width:auto}
  .toast-wrap{position:fixed;bottom:22px;right:22px;display:flex;flex-direction:column;gap:8px;z-index:999}
  .toast{padding:13px 20px;border-radius:11px;font-size:13px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,.14)}
  .toast-ok{background:#0f172a;color:#fff}.toast-err{background:#dc2626;color:#fff}
  th.sortable{cursor:pointer;user-select:none}
  th.sortable:hover{background:#eef6fb}
  .empty{text-align:center;padding:44px;color:#94a3b8;font-size:13.5px}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
  .tab-btn{padding:9px 16px;border-radius:9px;border:1px solid #e5e7eb;background:#fff;font-size:13px;font-weight:600;color:#475569;cursor:pointer;font-family:inherit;transition:all .15s}
  .tab-btn:hover{background:#f0f9ff;border-color:#bae6fd}
  .tab-btn.active{background:#0ea5e9;border-color:#0ea5e9;color:#fff}
  .tab-pane{display:none}.tab-pane.active{display:block}
  .tab-desc{font-size:12.5px;color:#64748b;background:#f8fafc;border:1px solid #eef2f7;border-radius:9px;padding:10px 14px;margin-bottom:14px}
  label .tip{cursor:help;border-bottom:1px dotted #94a3b8;font-weight:400;color:#94a3b8}
  .help-btn{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:#0369a1;background:#f0f9ff;border:1px solid #bae6fd;border-radius:99px;padding:4px 11px;cursor:help;font-weight:700;white-space:nowrap}
  .help-pop{display:none;position:fixed;width:400px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;background:#0f172a;color:#e2e8f0;border-radius:12px;padding:15px 17px;font-size:12px;font-weight:400;line-height:1.7;z-index:900;box-shadow:0 14px 36px rgba(0,0,0,.32);text-align:left;white-space:normal;cursor:default}
  .help-pop b{color:#7dd3fc}
  .help-pop .hp-title{font-size:13px;font-weight:800;color:#fff;display:block;margin-bottom:8px}
  .modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px}
  .modal{background:#fff;border-radius:16px;max-width:760px;width:100%;max-height:86vh;overflow:auto;padding:24px}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .spinner{width:18px;height:18px;border:2px solid #e5e7eb;border-top-color:#0ea5e9;border-radius:50%;animation:spin .6s linear infinite;display:inline-block;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:900px){.sidebar{position:static;width:100%;min-height:0}.main{margin-left:0}.content{padding:14px}.kpis{grid-template-columns:repeat(2,1fr)}.form-row{grid-template-columns:1fr}}
`;

function layout(title, body) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} - ${escHtml(APP_NAME)}</title><style>${css}</style></head><body>${body}
<div class="toast-wrap" id="toast-wrap"></div>
<script>
function toast(msg,isErr){var w=document.getElementById('toast-wrap'),el=document.createElement('div');el.className='toast '+(isErr?'toast-err':'toast-ok');el.textContent=msg;w.appendChild(el);setTimeout(function(){el.remove()},3500);}
if(/[?&](msg|err)=/.test(location.search)){try{history.replaceState(null,'',location.pathname);}catch(e){}}
async function api(url,body){var r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})});return r.json();}
function csvExport(rows,filename){var csv=rows.map(function(r){return r.map(function(c){c=String(c==null?'':c);return /[",\\n]/.test(c)?'"'+c.replace(/"/g,'""')+'"':c;}).join(',');}).join('\\n');
var blob=new Blob(['\\uFEFF'+csv],{type:'text/csv;charset=utf-8'});var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();}
</script></body></html>`;
}

function appLayout(req, title, content, activeMenu, opts = {}) {
  const { accounts = [], account = null, user = null, pendingCount = 0 } = opts;
  const client = isClient(req);
  const menu = [
    { id: 'dashboard', label: '📊 대시보드', href: BASE },
    { id: 'weekly', label: '📅 주차별 데이터', href: `${BASE}/weekly` },
  ];
  if (!client) {
    menu.push({ id: 'run', label: '⚡ 조정 실행', href: `${BASE}/run` });
  }
  menu.push({ id: 'approvals', label: `✅ 승인함${pendingCount ? ` (${pendingCount})` : ''}`, href: `${BASE}/approvals` });
  menu.push({ id: 'history', label: '🕘 히스토리', href: `${BASE}/history` });
  menu.push({ id: 'settings', label: client ? '⚙️ 설정 (열람)' : '⚙️ 설정', href: `${BASE}/settings` });
  if (!client) {
    menu.push({ id: 'viewers', label: '✉️ 광고주 초대', href: `${BASE}/viewers` });
  }

  // 전용 앱: 광고주 고정 표시 / 범용 앱: 광고주 선택 드롭다운
  const acctSel = PINNED_CUSTOMER_ID ? `
    <div style="padding:12px 16px;border-bottom:1px solid #1e293b">
      <label style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.08em">광고주</label>
      <div style="margin-top:6px;background:#1e293b;border:1px solid #334155;border-radius:9px;padding:9px 12px;color:#e2e8f0;font-size:12.5px;font-weight:700;display:flex;align-items:center;gap:8px">
        🎯 ${PINNED_LABEL} (${PINNED_CUSTOMER_ID})
        ${account ? '' : '<span style="color:#f59e0b;font-weight:500;font-size:11px">· 미연동</span>'}
      </div>
    </div>` : `
    <div style="padding:12px 16px;border-bottom:1px solid #1e293b">
      <label style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.08em">광고주 선택</label>
      ${accounts.length ? `
      <select onchange="fetch('${BASE}/api/select-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:this.value})}).then(function(){location.href='${BASE}'})"
        style="background:#1e293b;border-color:#334155;color:#e2e8f0;font-size:12.5px;margin-top:6px">
        ${accounts.map(a => `<option value="${a.id}" ${account && String(a.id) === String(account.id) ? 'selected' : ''}>${escHtml(a.name)} (${escHtml(a.customer_id)})</option>`).join('')}
      </select>` : `
      <div style="margin-top:6px;background:#1e293b;border:1px solid #334155;border-radius:9px;padding:9px 12px;color:#94a3b8;font-size:12px">등록된 광고주 없음</div>`}
    </div>`;

  // 채널 전환 (SPO ↔ PPO) — BASE 가 /spo 또는 /ppo 로 끝나는 마운트에서만 표시
  const chNav = /\/(spo|ppo)$/.test(BASE) ? `
    <div class="sb-section">솔루션</div>
    <a href="${BASE.replace(/\/(spo|ppo)$/, '/spo')}" class="sb-link ${CHANNEL === 'shopping' ? 'active' : ''}">🛒 쇼핑검색 성과최적화</a>
    <a href="${BASE.replace(/\/(spo|ppo)$/, '/ppo')}" class="sb-link ${CHANNEL === 'powerlink' ? 'active' : ''}">🔗 파워링크 성과최적화</a>` : '';

  return layout(title, `
  <div class="sidebar">
    <div class="sb-head">
      <div class="sb-logo">${escHtml(APP_NAME)}</div>
      <div class="sb-sub">${escHtml(APP_SUBTITLE)}</div>
    </div>
    ${chNav}
    ${acctSel}
    <div class="sb-section">메뉴</div>
    <div style="flex:1">
      ${menu.map(m => `<a href="${m.href}" class="sb-link ${activeMenu === m.id ? 'active' : ''}">${m.label}</a>`).join('')}
    </div>
    <div class="sb-foot">
      <a href="/smart-sa" class="sb-link" style="background:#1e293b;color:#93c5fd;font-weight:700;margin-bottom:6px" title="AUTO REPORT 리포트 솔루션으로 이동">📊 AUTO REPORT ↗</a>
      <div style="color:#94a3b8;font-size:12.5px;padding:4px 14px 8px">${escHtml(user?.name || '')} <span style="color:#475569">· ${client ? '광고주' : '마스터'}</span></div>
      <a href="${BASE}/logout" class="sb-link">🚪 로그아웃</a>
    </div>
  </div>
  <div class="main">
    <div class="topbar">
      <div class="topbar-title">${escHtml(title)}</div>
      ${account ? `<div class="topbar-acct">${escHtml(account.name)} · ${escHtml(account.customer_id)}</div>` : ''}
    </div>
    <div class="content">${content}</div>
  </div>`);
}

function verdictBadge(v) {
  const cls = v === logic.VERDICT.UP ? 'b-up' : v === logic.VERDICT.DOWN ? 'b-down'
    : v === logic.VERDICT.DOWN_HOLD || v === logic.VERDICT.NO_DATA ? 'b-warn'
    : v === logic.VERDICT.KEEP_RANK || v === logic.VERDICT.KEEP_NO_DOWN ? 'b-blue' : 'b-keep';
  return `<span class="badge ${cls}">${escHtml(v)}</span>`;
}

function statusBadge(s) {
  const map = {
    pending: ['승인 대기', 'b-warn'], hold_volume: ['감액보류', 'b-warn'], approved: ['승인됨', 'b-blue'], rejected: ['반려', 'b-keep'],
    applied: ['적용 완료', 'b-up'], auto_applied: ['자동 적용', 'b-up'], failed: ['실패', 'b-down'], skipped: ['해당 없음', 'b-keep'],
  };
  const [label, cls] = map[s] || [s, 'b-keep'];
  return `<span class="badge ${cls}">${label}</span>`;
}

async function pendingCount(accountId) {
  const rows = await bidDb.getAdjustments(accountId, { statusIn: ['pending', 'hold_volume'], limit: 1000 });
  return rows.filter(r => [logic.VERDICT.UP, logic.VERDICT.DOWN, logic.VERDICT.DOWN_HOLD].includes(r.verdict)).length;
}

// ═══════════════════════════════════════════════════════════════════
//  로그인 / 로그아웃
// ═══════════════════════════════════════════════════════════════════
router.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect(BASE);
  const err = req.query.err || '';
  res.send(layout('로그인', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#0f172a,#1e3a5f)">
      <div style="width:100%;max-width:400px;padding:16px">
        <div style="text-align:center;margin-bottom:30px">
          <div style="font-size:38px;margin-bottom:10px">🎯</div>
          <h1 style="font-size:22px;font-weight:800;color:#fff">${escHtml(APP_NAME)}</h1>
          <p style="color:#94a3b8;font-size:13px;margin-top:6px">네이버 쇼핑검색 입찰 자동 조정 시스템</p>
        </div>
        <div class="card"><div class="card-body">
          ${err === 'invalid' ? '<div class="alert alert-err">아이디 또는 비밀번호가 올바르지 않습니다.</div>' : ''}
          <form method="POST" action="${BASE}/login">
            <div style="margin-bottom:14px"><label>아이디 (광고주는 이메일)</label><input name="username" required autocomplete="username"></div>
            <div style="margin-bottom:16px"><label>비밀번호</label><input type="password" name="password" required autocomplete="current-password"></div>
            <button class="btn btn-primary" style="width:100%;justify-content:center">로그인</button>
          </form>
          <p style="font-size:12px;color:#94a3b8;text-align:center;margin-top:14px">운영자 계정은 뉴먼트 솔루션 계정과 동일합니다.<br>광고주는 초대 메일을 통해 계정을 만들 수 있습니다.</p>
        </div></div>
      </div>
    </div>`));
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.authenticateUser(username, password);
  if (!user) return res.redirect(303, `${BASE}/login?err=invalid`);
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = !!user.is_admin;
  req.session.approved = user.approved;
  req.session.role = user.role || 'marketer';
  req.session.bidRole = null;
  await resolveBidRole(req);
  req.session.save(() => res.redirect(303, BASE));
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect(`${BASE}/login`));
});

router.post('/api/select-account', requireLogin, async (req, res) => {
  const accounts = await getAccessibleAccounts(req);
  const target = accounts.find(a => String(a.id) === String(req.body.accountId));
  if (target) req.session[SEL_KEY] = target.id;
  req.session.save(() => res.json({ ok: !!target }));
});

// ═══════════════════════════════════════════════════════════════════
//  대시보드
// ═══════════════════════════════════════════════════════════════════
router.get('/', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) {
    return res.send(appLayout(req, '대시보드', `
      <div class="empty">🎯 ${PINNED_CUSTOMER_ID ? `${PINNED_LABEL}(${PINNED_CUSTOMER_ID}) 광고주가 아직 연동되지 않았습니다.` : '연동된 광고주가 없습니다.'}${isClient(req) ? ' 담당 마케터에게 문의해주세요.' : (PINNED_CUSTOMER_ID ? ` <a href="${BASE}/settings" style="color:#0ea5e9;font-weight:600">설정 &gt; API 연동</a>에서 연동해주세요.` : ` <a href="/smart-sa/accounts" style="color:#0ea5e9;font-weight:600">AUTO REPORT &gt; 광고주 관리</a>에서 등록하면 자동으로 연동됩니다.`)}</div>
    `, 'dashboard', { accounts, account, user }));
  }

  const weeks = logic.last4Weeks();
  const { rows, settings } = await engine.computeWeekly(account, { save: false });
  const blendN = Math.round(parseFloat(settings.blend_recent_weight) || 0);
  const pend = await pendingCount(account.id);
  const alerts = await bidDb.getAlerts(account.id, { unresolvedOnly: true, limit: 30 });

  // KPI 트렌드: 최근 12주 계정 전체 비용/구매전환매출/ROAS (활성 소재, 제외 캠페인 제외)
  const excludedC = logic.parseExcludedCampaigns(settings.excluded_campaigns);
  const trendRaw = (await bidDb.pool.query(`
    SELECT m.campaign_name, ws.week_start, ws.cost, ws.revenue
    FROM bid_weekly_stats ws JOIN bid_materials m ON m.id = ws.material_id
    WHERE m.account_id = $1 AND m.channel = $2 AND m.enabled = 1 AND COALESCE(m.auto_disabled, 0) = 0
  `, [account.id, CHANNEL])).rows;
  const trendMap = {};
  for (const t of trendRaw) {
    if (logic.isExcludedCampaign(t.campaign_name, excludedC)) continue;
    const wk = wkKey(t.week_start);
    if (!trendMap[wk]) trendMap[wk] = { cost: 0, revenue: 0 };
    trendMap[wk].cost += parseInt(t.cost) || 0;
    trendMap[wk].revenue += parseInt(t.revenue) || 0;
  }
  const trendWeeks = Object.keys(trendMap).sort().slice(-12)
    .map(wk => ({ week: wk, cost: trendMap[wk].cost, revenue: trendMap[wk].revenue }));

  // 최신 주차 요약
  let cost1 = 0, rev1 = 0, cost4 = 0, rev4 = 0;
  const dist = {};
  for (const r of rows) {
    cost1 += r.weekData[0].cost; rev1 += r.weekData[0].revenue;
    cost4 += r.cost4w; rev4 += r.revenue4w;
    dist[r.verdict] = (dist[r.verdict] || 0) + 1;
  }
  const totalBlendedNum = rows.reduce((a, r) => a + (r.blendedRoas != null ? r.blendedRoas * r.cost4w : 0), 0);
  const totalBlendedDen = rows.reduce((a, r) => a + (r.blendedRoas != null ? r.cost4w : 0), 0);
  const weightedBlended = totalBlendedDen > 0 ? totalBlendedNum / totalBlendedDen : null;

  const distHtml = Object.entries(dist).map(([v, n]) => `${verdictBadge(v)} <b style="margin-right:12px">${n}</b>`).join('');

  const alertsHtml = alerts.length ? `
    <div class="card">
      <div class="card-header"><span class="card-title">🚨 일간 트리거 알림 (자동 조정 없음 — 수동 대응)</span></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table>
        <tr><th>일자</th><th>소재</th><th>분류</th><th class="num">당일 비용</th><th class="num">4주 일평균</th><th class="num">당일 ROAS</th><th class="num">보정목표</th>${isClient(req) ? '' : '<th>조치</th>'}</tr>
        ${alerts.map(a => `<tr>
          <td>${wkKey(a.alert_date)}</td>
          <td><b>${escHtml(a.material_name)}</b><br><span style="color:#94a3b8;font-size:11px">${escHtml(a.campaign_name)} · ${escHtml(a.adgroup_name)}</span></td>
          <td>${escHtml(a.category)}</td>
          <td class="num" style="color:#dc2626;font-weight:700">${fmtNum(a.day_cost)}원</td>
          <td class="num">${fmtNum(a.avg_cost)}원</td>
          <td class="num">${fmtRoas(a.day_roas)}</td>
          <td class="num">${fmtRoas(a.target_roas)}</td>
          ${isClient(req) ? '' : `<td style="white-space:nowrap">
            <button class="btn btn-outline btn-sm" onclick="alertAdjust(${a.id},${a.material_id},-0.03)">-3%</button>
            <button class="btn btn-outline btn-sm" onclick="alertAdjust(${a.id},${a.material_id},0.03)">+3%</button>
            <button class="btn btn-outline btn-sm" onclick="alertResolve(${a.id})">확인</button>
          </td>`}
        </tr>`).join('')}
      </table></div>
    </div>
    <script>
    async function alertAdjust(alertId, materialId, rate){
      if(!confirm((rate>0?'+3%':'-3%')+' 수동 조정을 즉시 적용할까요?'))return;
      var j=await api('${BASE}/api/alerts/adjust',{alertId:alertId,materialId:materialId,rate:rate});
      if(j.ok){toast('조정 적용 완료 ('+j.appliedBid.toLocaleString()+'원)');setTimeout(function(){location.reload()},800);}else toast(j.error||'실패',true);
    }
    async function alertResolve(id){var j=await api('${BASE}/api/alerts/resolve',{id:id});if(j.ok)location.reload();}
    </script>` : '';

  const content = `
    <div class="kpis">
      <div class="kpi"><div class="kpi-l">최신 완료 주 비용 (${weeks[0].start} ~)</div><div class="kpi-v">${fmtNum(cost1)}원</div><div class="kpi-s">4주 누적 ${fmtNum(cost4)}원</div></div>
      <div class="kpi g"><div class="kpi-l">최신 완료 주 구매전환매출</div><div class="kpi-v">${fmtNum(rev1)}원</div><div class="kpi-s">4주 누적 ${fmtNum(rev4)}원</div></div>
      <div class="kpi p"><div class="kpi-l">가중 블렌딩 ROAS (전체)</div><div class="kpi-v">${fmtRoas(weightedBlended)}</div><div class="kpi-s">1주차 ${blendN}% · 2~4주차 ${100 - blendN}%</div></div>
      <div class="kpi o"><div class="kpi-l">승인 대기</div><div class="kpi-v">${pend}건</div><div class="kpi-s"><a href="${BASE}/approvals" style="color:#0ea5e9;font-weight:600">승인함 바로가기 →</a></div></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">📈 주간 성과 트렌드 (최근 12주)</span>
      <span style="font-size:12px;color:#94a3b8">활성 소재 합산 · 매출 = 구매전환매출 · 하단 보라 = 주간 ROAS · 소재별 상세는 <a href="${BASE}/weekly" style="color:#0ea5e9;font-weight:600">주차별 데이터</a></span></div>
      <div class="card-body" id="kpi-trend"><div class="empty" style="padding:16px"><span class="spinner"></span></div></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">판정 분포 (최신 주차 기준 계산)</span>
      <span style="font-size:12px;color:#94a3b8">소재 ${rows.length}개 · 데이터 기준 주 ${weeks[0].start} ~ ${weeks[0].end}</span></div>
      <div class="card-body">${distHtml || '<span class="empty" style="padding:0">데이터가 없습니다. 소재 동기화 후 성과가 수집되면 표시됩니다.</span>'}</div>
    </div>
    ${alertsHtml}
    ${!rows.length && !isClient(req) ? `<div class="alert alert-info">소재가 없습니다. <a href="${BASE}/run" style="font-weight:700;color:#0369a1">조정 실행</a> 페이지에서 "소재 동기화 + 성과 수집"을 먼저 실행해주세요.</div>` : ''}
    <script>
    // KPI 트렌드 차트 (최근 12주 비용/구매전환매출 라인 + 주간 ROAS 라벨)
    var TREND=${JSON.stringify(trendWeeks)};
    (function(){
      var el=document.getElementById('kpi-trend');
      if(!TREND.length){el.innerHTML='<div class="empty" style="padding:16px">주차 데이터가 쌓이면 트렌드가 표시됩니다.</div>';return;}
      var W=960,H=300,P=58;
      var max=Math.max.apply(null,TREND.map(function(w){return Math.max(w.cost,w.revenue)}).concat([1]));
      function x(i){return P+i*(W-2*P)/Math.max(TREND.length-1,1);}
      function y(v){return H-P-(v/max)*(H-2*P);}
      function fmtM(v){return v>=100000000?(v/100000000).toFixed(1)+'억':v>=10000?Math.round(v/10000).toLocaleString('ko-KR')+'만':Math.round(v).toLocaleString('ko-KR');}
      var grid='';
      for(var g=1;g<=4;g++){var gv=max*g/4,gy=y(gv);
        grid+='<line x1="'+P+'" y1="'+gy+'" x2="'+(W-P)+'" y2="'+gy+'" stroke="#eef2f7"/>'
          +'<text x="'+(P-8)+'" y="'+(gy+3)+'" text-anchor="end" font-size="10" fill="#94a3b8">'+fmtM(gv)+'</text>';}
      function line(key,color){return '<polyline fill="none" stroke="'+color+'" stroke-width="2.5" points="'+TREND.map(function(w,i){return x(i)+','+y(w[key])}).join(' ')+'"/>'
        +TREND.map(function(w,i){return '<circle cx="'+x(i)+'" cy="'+y(w[key])+'" r="3.5" fill="'+color+'"><title>'+w.week+' · '+w[key].toLocaleString('ko-KR')+'원</title></circle>'}).join('');}
      var labels=TREND.map(function(w,i){var ro=w.cost>0?(w.revenue/w.cost*100).toFixed(0)+'%':'-';
        return '<text x="'+x(i)+'" y="'+(H-P+18)+'" text-anchor="middle" font-size="10" fill="#64748b">'+w.week.slice(5).replace('-','/')+'</text>'
          +'<text x="'+x(i)+'" y="'+(H-P+33)+'" text-anchor="middle" font-size="10" fill="#8b5cf6" font-weight="700">'+ro+'</text>';}).join('');
      el.innerHTML='<svg viewBox="0 0 '+W+' '+(H+16)+'" style="width:100%;background:#fafcfe;border-radius:10px">'
        +grid
        +'<line x1="'+P+'" y1="'+(H-P)+'" x2="'+(W-P)+'" y2="'+(H-P)+'" stroke="#e2e8f0"/>'
        +line('cost','#0ea5e9')+line('revenue','#10b981')+labels
        +'<rect x="'+P+'" y="14" width="10" height="10" fill="#0ea5e9"/><text x="'+(P+16)+'" y="23" font-size="11" fill="#334155">비용</text>'
        +'<rect x="'+(P+74)+'" y="14" width="10" height="10" fill="#10b981"/><text x="'+(P+90)+'" y="23" font-size="11" fill="#334155">구매전환매출</text></svg>';
    })();
    </script>
  `;
  res.send(appLayout(req, '대시보드', content, 'dashboard', { accounts, account, user, pendingCount: pend }));
});

// ═══════════════════════════════════════════════════════════════════
//  주차별 데이터
// ═══════════════════════════════════════════════════════════════════
router.get('/weekly', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const pend = await pendingCount(account.id);
  const master = !isClient(req);

  // 직접 설정용 주간 목록 (최신 완료 주부터 26주, 월~일)
  const weekOpts = [];
  {
    const mon = new Date(logic.last4Weeks()[0].start + 'T00:00:00Z');
    for (let i = 0; i < 26; i++) {
      const start = logic.fmtDate(mon);
      const end = new Date(mon); end.setUTCDate(end.getUTCDate() + 6);
      weekOpts.push({ start, end: logic.fmtDate(end) });
      mon.setUTCDate(mon.getUTCDate() - 7);
    }
  }

  const content = `
    <div class="toolbar">
      <select id="wk-preset" title="열람 기간 (주 단위, 월~일)">
        <option value="4" selected>최근 4주</option>
        <option value="8">최근 8주</option>
        <option value="12">최근 12주</option>
        <option value="custom">기간 직접 설정</option>
      </select>
      <span id="wk-custom" style="display:none;align-items:center;gap:6px">
        <select id="wk-from">${weekOpts.map(w => `<option value="${w.start}">${w.start} ~ ${w.end}</option>`).join('')}</select>
        <span style="color:#94a3b8">~</span>
        <select id="wk-to">${weekOpts.map((w, i) => `<option value="${w.start}" ${i === 0 ? 'selected' : ''}>${w.start} ~ ${w.end}</option>`).join('')}</select>
        <button class="btn btn-outline btn-sm" onclick="loadData()">적용</button>
      </span>
      <input id="f-q" placeholder="${UNIT}/캠페인/ID 검색..." style="width:220px">
      <button class="btn btn-outline btn-sm" onclick="resetFilt()" id="filt-reset" style="display:none">필터 초기화</button>
      <span style="flex:1"></span>
      <button class="btn btn-outline btn-sm" onclick="exportCsv()">📥 CSV 내보내기</button>
    </div>
    <div class="alert alert-info" style="font-size:12.5px">열 제목의 <b>⏷</b>를 누르면 엑셀처럼 값을 골라 필터링할 수 있습니다. 주차 열은 [비용/매출/ROAS/입찰가/변경입찰가] — 변경입찰가는 그 주에 입찰가 변경(솔루션 적용 또는 광고시스템 외부 변경)이 있었을 때만 표시됩니다. <b>소재~보정목표 열 고정</b>, 판정 열은 최근 4주 기준으로 맨 오른쪽에 있습니다.</div>
    <div class="tbl-wrap" id="wk-wrap"><div class="empty"><span class="spinner"></span> 불러오는 중...</div></div>
    <div id="filt-pop" style="display:none;position:fixed;background:#fff;border:1px solid #e5e7eb;border-radius:11px;box-shadow:0 12px 32px rgba(0,0,0,.18);z-index:700;min-width:200px;max-width:300px"></div>
    <div id="trend-modal" style="display:none"></div>
    <script>
    var DATA=[],WEEKS=[],SORT_K='',SORT_DIR=-1,MASTER=${master ? 'true' : 'false'},UNIT='${UNIT}';
    var CATS=${JSON.stringify(logic.CATEGORIES)};
    var LATEST='${weekOpts[0].start}';
    var FILT={campaignName:null,category:null,verdict:null,coreLabel:null}; // null=전체, Set=선택값만
    var FILT_LABEL={campaignName:'캠페인',category:'분류',verdict:'판정',coreLabel:'핵심'};
    function addDays(iso,d){var t=new Date(iso+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+d);return t.toISOString().slice(0,10);}
    document.getElementById('wk-preset').onchange=function(){
      var custom=this.value==='custom';
      document.getElementById('wk-custom').style.display=custom?'inline-flex':'none';
      if(!custom)loadData();
    };
    function range(){
      var p=document.getElementById('wk-preset').value;
      if(p==='custom'){
        var f=document.getElementById('wk-from').value,t=document.getElementById('wk-to').value;
        return f<=t?{from:f,to:t}:{from:t,to:f};
      }
      var n=parseInt(p);
      return {from:addDays(LATEST,-(n-1)*7),to:LATEST};
    }
    function loadData(){
      var rg=range();
      document.getElementById('wk-wrap').innerHTML='<div class="empty"><span class="spinner"></span> 불러오는 중...</div>';
      fetch('${BASE}/api/weekly?from='+rg.from+'&to='+rg.to).then(function(r){return r.json()}).then(function(j){
        if(!j.ok){document.getElementById('wk-wrap').innerHTML='<div class="empty">'+(j.error||'오류')+'</div>';return;}
        DATA=j.rows.map(function(r){r.coreLabel=r.isCore?'핵심':'일반';return r;});
        WEEKS=j.weeks;render();
        var w=document.getElementById('wk-wrap');w.scrollLeft=w.scrollWidth; // 최신 주·판정 열이 보이도록 오른쪽 끝으로
      });
    }
    loadData();
    document.getElementById('f-q').oninput=function(){render()};
    function fnum(n){return n==null?'-':Math.round(n).toLocaleString('ko-KR');}
    function froas(r){return r==null?'-':(r*100).toFixed(0)+'%';}
    function getVal(r,k){
      if(k.indexOf('wk:')===0){
        var p=k.split(':'),d=r.wk[WEEKS[parseInt(p[1])]]||{};
        if(p[2]==='c')return d.c||0; if(p[2]==='r')return d.r||0;
        if(p[2]==='b')return d.b==null?null:d.b; if(p[2]==='a')return d.a==null?null:d.a;
        return (d.c>0)?(d.r||0)/d.c:null;
      }
      return r[k];
    }
    // ─── 엑셀식 열 필터 ───
    function openFilt(key,ev){
      ev.stopPropagation();
      var pop=document.getElementById('filt-pop');
      var vals={};DATA.forEach(function(r){vals[r[key]||'(없음)']=1;});
      var list=Object.keys(vals).sort(function(a,b){return a.localeCompare(b,'ko')});
      var cur=FILT[key];
      pop.innerHTML='<div style="padding:10px 12px;border-bottom:1px solid #f1f5f9;font-weight:700;font-size:12.5px">'+FILT_LABEL[key]+' 필터</div>'
        +'<div style="max-height:260px;overflow:auto;padding:6px 0">'
        +list.map(function(v){
          var chk=(cur===null||cur.has(v))?'checked':'';
          return '<label style="display:flex;align-items:center;gap:8px;padding:5px 14px;margin:0;font-size:12.5px;color:#334155;cursor:pointer;font-weight:400">'
            +'<input type="checkbox" class="filt-chk" value="'+v.replace(/"/g,'&quot;')+'" '+chk+' style="width:auto">'+v+'</label>';
        }).join('')+'</div>'
        +'<div style="display:flex;gap:6px;padding:10px 12px;border-top:1px solid #f1f5f9">'
        +'<button class="btn btn-primary btn-sm" onclick="applyFilt(\\''+key+'\\')">적용</button>'
        +'<button class="btn btn-outline btn-sm" onclick="document.querySelectorAll(\\'.filt-chk\\').forEach(function(c){c.checked=true})">전체 선택</button>'
        +'<button class="btn btn-outline btn-sm" onclick="document.querySelectorAll(\\'.filt-chk\\').forEach(function(c){c.checked=false})">해제</button>'
        +'</div>';
      pop.style.display='block';
      var x=Math.min(ev.clientX,window.innerWidth-320),y=Math.min(ev.clientY+12,window.innerHeight-380);
      pop.style.left=Math.max(8,x)+'px';pop.style.top=Math.max(8,y)+'px';
    }
    function applyFilt(key){
      var checked=[],total=0;
      document.querySelectorAll('.filt-chk').forEach(function(c){total++;if(c.checked)checked.push(c.value);});
      FILT[key]=(checked.length===total)?null:new Set(checked);
      document.getElementById('filt-pop').style.display='none';
      updateFiltReset();render();
    }
    function resetFilt(){FILT={campaignName:null,category:null,verdict:null,coreLabel:null};updateFiltReset();render();}
    function updateFiltReset(){
      var on=Object.keys(FILT).some(function(k){return FILT[k]!==null});
      document.getElementById('filt-reset').style.display=on?'':'none';
    }
    document.addEventListener('click',function(e){
      var pop=document.getElementById('filt-pop');
      if(pop.style.display!=='none'&&(!e.target.closest||!e.target.closest('#filt-pop')))pop.style.display='none';
    });
    function fIcon(key){
      var on=FILT[key]!==null;
      return ' <span onclick="openFilt(\\''+key+'\\',event)" title="'+FILT_LABEL[key]+' 필터" style="cursor:pointer;color:'+(on?'#0ea5e9':'#b7c3d0')+';font-size:11px">'+(on?'▼':'⏷')+'</span>';
    }
    function filtered(){
      var q=document.getElementById('f-q').value.toLowerCase();
      var rows=DATA.filter(function(r){
        for(var k in FILT){if(FILT[k]&&!FILT[k].has(r[k]||'(없음)'))return false;}
        if(q&&(r.name+' '+r.campaignName+' '+r.adgroupName+' '+r.adId).toLowerCase().indexOf(q)===-1)return false;
        return true;});
      if(SORT_K){
        var strKeys={name:1,adId:1,category:1,verdict:1};
        rows=rows.slice().sort(function(a,b){
          var x=getVal(a,SORT_K),y=getVal(b,SORT_K);
          if(strKeys[SORT_K])return String(x||'').localeCompare(String(y||''),'ko')*(-SORT_DIR);
          x=(x==null||x===false)?-Infinity:(x===true?1:x);y=(y==null||y===false)?-Infinity:(y===true?1:y);
          return (y-x)*(SORT_DIR<0?1:-1);});
      }
      return rows;
    }
    function vbadge(v){var cls=v==='증액'?'b-up':v==='감액'?'b-down':(v==='데이터부족'||v.indexOf('감액보류')===0)?'b-warn':(v.indexOf('유지-')===0?'b-blue':'b-keep');return '<span class="badge '+cls+'">'+v+'</span>';}
    function catCell(r){
      if(!MASTER)return r.category;
      return '<select onclick="event.stopPropagation()" onchange="catChange('+r.id+',this)" style="width:96px;padding:4px 6px;font-size:12px">'
        +CATS.map(function(c){return '<option '+(r.category===c?'selected':'')+'>'+c+'</option>';}).join('')+'</select>';
    }
    async function catChange(id,sel){
      var v=sel.value;
      var mats={};mats[id]={category:v};
      var j=await api('${BASE}/api/settings/materials',{materials:mats});
      if(j.ok){toast('분류 저장 완료 — 판정은 새로고침 시 반영');var r=DATA.find(function(x){return x.id===id});if(r)r.category=v;}
      else toast(j.error||'저장 실패',true);
    }
    // 고정(좌측 sticky) 열: 소재 / 소재ID / 분류 / 목표 / 보정목표
    var S1='position:sticky;left:0;min-width:220px;max-width:220px;background:#fff;z-index:2;';
    var S1b='position:sticky;left:220px;min-width:128px;max-width:128px;background:#fff;z-index:2;';
    var S2='position:sticky;left:348px;min-width:104px;max-width:104px;background:#fff;z-index:2;';
    var S3='position:sticky;left:452px;min-width:62px;max-width:62px;background:#fff;z-index:2;';
    var S4='position:sticky;left:514px;min-width:78px;max-width:78px;background:#fff;z-index:2;';
    var HS='background:#f8fafc;z-index:6;';
    function sortTh(k,label,extra,cls,fkey){
      var arrow=SORT_K===k?(SORT_DIR<0?' ▼':' ▲'):'';
      return '<th class="'+(cls||'')+'" style="cursor:pointer;'+(extra||'')+'" onclick="doSort(\\''+k+'\\')">'+label+arrow+(fkey?fIcon(fkey):'')+'</th>';
    }
    function doSort(k){
      if(SORT_K===k){SORT_DIR=-SORT_DIR;}else{SORT_K=k;SORT_DIR=-1;}
      render();
    }
    function render(){
      var rows=filtered();
      var h='<table style="border-collapse:separate;border-spacing:0"><thead><tr>'
        +sortTh('name','${UNIT}',S1+HS,'','campaignName')
        +sortTh('adId','${UNIT}ID',S1b+HS)
        +sortTh('category','분류',S2+HS,'','category')
        +sortTh('targetRoas','목표',S3+HS,'num')
        +sortTh('adjustedTarget','보정목표',S4+HS,'num');
      WEEKS.forEach(function(w,i){
        var wk=w.slice(5).replace('-','/');
        h+=sortTh('wk:'+i+':c',wk+'<br>비용','border-left:2px solid #e2e8f0;','num')
          +sortTh('wk:'+i+':r',wk+'<br>매출','','num')
          +sortTh('wk:'+i+':o',wk+'<br>ROAS','','num')
          +sortTh('wk:'+i+':b',wk+'<br>입찰가','','num')
          +sortTh('wk:'+i+':a',wk+'<br>변경입찰가','','num');
      });
      h+=sortTh('blended','블렌딩ROAS','border-left:2px solid #e2e8f0;','num')
        +sortTh('rank1','노출순위','','num')+sortTh('share','매출비중','','num')
        +sortTh('coreLabel','핵심','','','coreLabel')+sortTh('verdict','판정','','','verdict')
        +sortTh('currentBid','현재입찰가','','num')+sortTh('calcBid','권장입찰가','','num')
        +'</tr></thead><tbody>';
      h+=rows.map(function(r){
        var row='<tr style="cursor:pointer" onclick="showTrend('+r.id+')">'
        +'<td style="'+S1+'"><b>'+r.name+'</b><br><span style="color:#94a3b8;font-size:11px">'+r.campaignName+' · '+r.adgroupName+'</span></td>'
        +'<td style="'+S1b+'font-size:11px;color:#64748b;word-break:break-all">'+r.adId+'</td>'
        +'<td style="'+S2+'">'+catCell(r)+'</td>'
        +'<td class="num" style="'+S3+'">'+froas(r.targetRoas)+'</td>'
        +'<td class="num" style="'+S4+'">'+froas(r.adjustedTarget)+'</td>';
        WEEKS.forEach(function(w){
          var d=r.wk[w]||{};
          var c=d.c||0,rev=d.r||0;
          var ro=c>0?(rev/c*100).toFixed(0)+'%':'-';
          var chg='';
          if(d.a!=null){
            var up=d.b!=null&&d.a>d.b;
            chg='<span style="font-weight:700;color:'+(up?'#059669':'#dc2626')+'">'+fnum(d.a)+'</span>';
          }
          row+='<td class="num" style="border-left:2px solid #f1f5f9">'+fnum(c)+'</td>'
            +'<td class="num">'+fnum(rev)+'</td>'
            +'<td class="num" style="font-weight:600;color:#7c3aed">'+ro+'</td>'
            +'<td class="num">'+(d.b==null?'-':fnum(d.b))+'</td>'
            +'<td class="num">'+chg+'</td>';
        });
        row+='<td class="num" style="font-weight:700;border-left:2px solid #f1f5f9">'+froas(r.blended)+'</td>'
        +'<td class="num">'+(r.rank1?r.rank1.toFixed(1):'-')+'</td>'
        +'<td class="num">'+(r.share*100).toFixed(1)+'%</td>'
        +'<td>'+(r.isCore?'<span class="badge b-core">핵심</span>':'')+'</td>'
        +'<td>'+vbadge(r.verdict)+'</td>'
        +'<td class="num">'+fnum(r.currentBid)+'원</td>'
        +'<td class="num" style="font-weight:700;color:'+(r.calcBid>r.currentBid?'#059669':r.calcBid<r.currentBid?'#dc2626':'#334155')+'">'+fnum(r.calcBid)+'원</td></tr>';
        return row;
      }).join('');
      h+='</tbody></table>';
      if(!rows.length)h='<div class="empty">데이터 없음</div>';
      document.getElementById('wk-wrap').innerHTML=h;
    }
    function exportCsv(){
      var head=['소재','소재ID','캠페인','광고그룹','분류','목표ROAS','보정목표'];
      WEEKS.forEach(function(w){head.push(w+' 비용',w+' 매출',w+' ROAS',w+' 입찰가',w+' 변경입찰가');});
      head=head.concat(['블렌딩ROAS','노출순위','매출비중','핵심','판정','현재입찰가','권장입찰가']);
      var rows=filtered().map(function(r){
        var line=[r.name,r.adId,r.campaignName,r.adgroupName,r.category,r.targetRoas,r.adjustedTarget];
        WEEKS.forEach(function(w){var d=r.wk[w]||{};line.push(d.c||0,d.r||0,(d.c>0)?((d.r||0)/d.c).toFixed(3):'',d.b==null?'':d.b,d.a==null?'':d.a);});
        return line.concat([r.blended==null?'':r.blended.toFixed(3),r.rank1||'',(r.share*100).toFixed(1)+'%',r.isCore?'Y':'',r.verdict,r.currentBid,r.calcBid]);
      });
      var rg=range();
      csvExport([head].concat(rows),'입찰조정_주차별데이터_'+rg.from+'_'+rg.to+'.csv');
    }
    // 소재 클릭 → 주차별 추이 차트 (SVG)
    async function showTrend(id){
      var r=await fetch('${BASE}/api/material-trend?materialId='+id).then(function(x){return x.json()});
      if(!r.ok){toast(r.error||'추이 조회 실패',true);return;}
      var m=document.getElementById('trend-modal');
      m.style.display='block';
      m.innerHTML='<div class="modal-bg" onclick="if(event.target===this)this.parentNode.style.display=\\'none\\'"><div class="modal">'
        +'<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><b style="font-size:15px">'+r.name+' · 주차별 추이</b>'
        +'<button class="btn btn-outline btn-sm" onclick="document.getElementById(\\'trend-modal\\').style.display=\\'none\\'">닫기</button></div>'
        +svgChart(r.weeks)+'</div></div>';
    }
    function svgChart(weeks){
      if(!weeks.length)return '<div class="empty">데이터 없음</div>';
      var W=700,H=260,P=46;
      var maxCost=Math.max.apply(null,weeks.map(function(w){return Math.max(w.cost,w.revenue)}).concat([1]));
      function x(i){return P+i*(W-2*P)/Math.max(weeks.length-1,1);}
      function y(v){return H-P-(v/maxCost)*(H-2*P);}
      function line(key,color){return '<polyline fill="none" stroke="'+color+'" stroke-width="2.5" points="'+weeks.map(function(w,i){return x(i)+','+y(w[key])}).join(' ')+'"/>'
        +weeks.map(function(w,i){return '<circle cx="'+x(i)+'" cy="'+y(w[key])+'" r="3.5" fill="'+color+'"/>'}).join('');}
      var roasTxt=weeks.map(function(w,i){var ro=w.cost>0?(w.revenue/w.cost*100).toFixed(0)+'%':'-';return '<text x="'+x(i)+'" y="'+(H-P+18)+'" text-anchor="middle" font-size="10" fill="#64748b">'+w.week+'</text><text x="'+x(i)+'" y="'+(H-P+32)+'" text-anchor="middle" font-size="10" fill="#8b5cf6" font-weight="700">ROAS '+ro+'</text>';}).join('');
      return '<svg viewBox="0 0 '+W+' '+(H+20)+'" style="width:100%;background:#fafcfe;border-radius:10px">'
        +'<line x1="'+P+'" y1="'+(H-P)+'" x2="'+(W-P)+'" y2="'+(H-P)+'" stroke="#e2e8f0"/>'
        +line('cost','#0ea5e9')+line('revenue','#10b981')+roasTxt
        +'<rect x="'+P+'" y="12" width="10" height="10" fill="#0ea5e9"/><text x="'+(P+16)+'" y="21" font-size="11" fill="#334155">비용</text>'
        +'<rect x="'+(P+70)+'" y="12" width="10" height="10" fill="#10b981"/><text x="'+(P+86)+'" y="21" font-size="11" fill="#334155">구매전환매출</text></svg>';
    }
    </script>
  `;
  res.send(appLayout(req, '주차별 데이터', content, 'weekly', { accounts, account, user, pendingCount: pend }));
});

// 주차별 데이터: 판정(최근 4주 기준) + 선택 기간의 주차별 비용/매출/입찰가 매트릭스
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (월요일, 월~일 주 단위) — 기본 최근 4주
// 주차별 입찰가: b=해당 주 입찰가(변경 전), a=변경 후 입찰가(그 주 변경이 있었을 때만)
//   출처 ① 솔루션 적용 이력(bid_adjustments applied/auto_applied) ② 주간 동기화 외부 변경 감지(bid_weekly_stats 스냅샷)
router.get('/api/weekly', requireLogin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const latest = logic.last4Weeks()[0].start;
    const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
    const addDays = (iso, d) => { const t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return logic.fmtDate(t); };
    let from = isDate(req.query.from) ? logic.mondayOf(req.query.from) : addDays(latest, -21);
    let to = isDate(req.query.to) ? logic.mondayOf(req.query.to) : latest;
    if (from > to) { const t = from; from = to; to = t; }
    // 주 목록 생성 (최대 54주 제한)
    const weeks = [];
    for (let w = from; w <= to && weeks.length < 54; w = addDays(w, 7)) weeks.push(w);

    const { rows } = await engine.computeWeekly(account, { save: false });
    const stat = (await bidDb.pool.query(`
      SELECT ws.material_id, ws.week_start, ws.cost, ws.revenue, ws.week_bid, ws.bid_change_from
      FROM bid_weekly_stats ws JOIN bid_materials m ON m.id = ws.material_id
      WHERE m.account_id = $1 AND ws.week_start BETWEEN $2 AND $3
    `, [account.id, from, to])).rows;
    // 솔루션 적용 이력 (그 주 첫 변경 전 값 + 마지막 변경 후 값)
    const adjRows = (await bidDb.pool.query(`
      SELECT material_id, week_start, prev_bid, applied_bid, applied_at
      FROM bid_adjustments
      WHERE account_id = $1 AND status IN ('applied','auto_applied') AND applied_bid IS NOT NULL
        AND week_start BETWEEN $2 AND $3
      ORDER BY applied_at ASC NULLS FIRST
    `, [account.id, from, to])).rows;
    const adjMap = {};
    for (const a of adjRows) {
      const wk = wkKey(a.week_start);
      if (!adjMap[a.material_id]) adjMap[a.material_id] = {};
      const cur = adjMap[a.material_id][wk];
      if (!cur) adjMap[a.material_id][wk] = { before: parseInt(a.prev_bid) || null, after: parseInt(a.applied_bid) || null };
      else cur.after = parseInt(a.applied_bid) || cur.after; // 같은 주 여러 번 적용 → 마지막 값
    }
    const wkMap = {};
    for (const s of stat) {
      const wk = wkKey(s.week_start);
      if (!wkMap[s.material_id]) wkMap[s.material_id] = {};
      wkMap[s.material_id][wk] = {
        c: parseInt(s.cost) || 0, r: parseInt(s.revenue) || 0,
        wb: s.week_bid == null ? null : parseInt(s.week_bid),
        cf: s.bid_change_from == null ? null : parseInt(s.bid_change_from),
      };
    }
    const totalRev = rows.reduce((a, r) => a + r.revenue4w, 0);
    res.json({
      ok: true, weeks,
      rows: rows.map(r => {
        const wkOut = {};
        const snaps = wkMap[r.materialId] || {};
        const adjs = adjMap[r.materialId] || {};
        for (const wk of weeks) {
          const s = snaps[wk]; const adj = adjs[wk];
          if (!s && !adj) continue;
          const cf = s?.cf ?? null, wb = s?.wb ?? null;
          // 변경 전 값: 스냅샷 감지값 → 솔루션 이력 → 해당 주 입찰가 순
          const before = cf != null ? cf : (adj ? adj.before : wb);
          // 변경 후 값: 솔루션 이력 → 스냅샷 감지(변경 전 값이 있으면 주 입찰가가 곧 변경 후) 순
          const after = adj ? adj.after : (cf != null ? wb : null);
          wkOut[wk] = { c: s?.c || 0, r: s?.r || 0, b: before, a: after };
        }
        return {
          id: r.materialId, name: r.material.name, adId: r.material.ncc_ad_id,
          campaignName: r.material.campaign_name, adgroupName: r.material.adgroup_name,
          category: r.material.category, targetRoas: r.material.target_roas,
          adjustedTarget: r.adjustedTarget, blended: r.blendedRoas,
          rank1: r.weekData[0].rank,
          share: totalRev > 0 ? r.revenue4w / totalRev : 0,
          isCore: r.isCore, verdict: r.verdict,
          currentBid: r.prevBid, calcBid: r.calcBid,
          wk: wkOut,
        };
      }),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.get('/api/material-trend', requireLogin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const m = await bidDb.getMaterialById(req.query.materialId, account.id);
    if (!m) return res.json({ ok: false, error: '소재 없음' });
    const rows = await bidDb.pool.query(
      'SELECT * FROM bid_weekly_stats WHERE material_id = $1 ORDER BY week_start ASC LIMIT 26', [m.id]);
    res.json({
      ok: true, name: m.name,
      weeks: rows.rows.map(w => ({
        week: wkKey(w.week_start).slice(5), cost: parseInt(w.cost) || 0, revenue: parseInt(w.revenue) || 0,
      })),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
//  조정 실행 (운영자)
// ═══════════════════════════════════════════════════════════════════
router.get('/run', requireLogin, requireMaster, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const settings = await bidDb.getSettings(account.id);
  const pend = await pendingCount(account.id);
  const mats = await bidDb.getMaterials(account.id, { enabledOnly: true });
  // 마지막 수집 시각 (소재 동기화 기준)
  const lastSyncRow = (await bidDb.pool.query(
    'SELECT MAX(synced_at) AS t FROM bid_materials WHERE account_id = $1', [account.id])).rows[0];
  const lastSync = lastSyncRow?.t ? new Date(lastSyncRow.t).toLocaleString('ko-KR') : null;
  const cronOn = settings.app_enabled === '1';

  const content = `
    <div class="alert alert-info">현재 조정 모드: <b>${settings.adjust_mode === 'auto' ? '자동 적용 (auto)' : '승인 후 적용 (approval)'}</b>
      · auto 모드여도 변경 폭 ±${Math.round(settings.force_approval_delta * 100)}% 초과 건은 무조건 승인이 필요합니다.
      모드는 <a href="${BASE}/settings" style="font-weight:700;color:#0369a1">설정</a>에서 변경.</div>
    <div class="alert ${cronOn ? 'alert-ok' : 'alert-err'}">
      ${cronOn
        ? '⏰ <b>주간 자동 실행 ON</b> — 매주 월요일 08:00(KST)에 소재 동기화 + 4주 성과 수집 + 판정이 자동 실행됩니다. 아래 버튼은 그 사이 수동으로 갱신하고 싶을 때만 사용하면 됩니다.'
        : `⏰ <b>주간 자동 실행 OFF</b> — <a href="${BASE}/settings#auto" style="font-weight:700;color:#dc2626;text-decoration:underline">설정 &gt; 자동화</a>에서 "주기 자동 실행(크론) 사용"을 켜면 매주 월요일 08:00에 수집·판정이 자동 실행됩니다.`}
    </div>
    <div class="card"><div class="card-header"><span class="card-title">1) 데이터 준비</span>
      <span style="font-size:12px;color:#94a3b8">활성 ${UNIT} ${mats.length}개${lastSync ? ` · 마지막 수집 ${lastSync}` : ''}</span></div>
      <div class="card-body">
        <button class="btn btn-primary" id="btn-sync" onclick="runSync()">🔄 ${UNIT} 동기화 + 4주 성과 수집 (수동)</button>
        <span id="sync-status" style="margin-left:10px;font-size:13px;color:#64748b">${lastSync ? `마지막 수집: ${lastSync}` : '아직 수집 이력이 없습니다.'}</span>
      </div></div>
    <div class="card"><div class="card-header"><span class="card-title">2) 계산 결과 미리보기 → 적용</span>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input id="pv-q" placeholder="${UNIT} 이름 검색..." style="width:200px" oninput="renderPv()">
        <button class="btn btn-outline btn-sm" onclick="loadPreview()">미리보기 새로고침</button>
        <button class="btn btn-green btn-sm" id="btn-apply-sel" onclick="applySelected()" disabled>선택 적용</button>
        <button class="btn btn-danger btn-sm" id="btn-apply-all" onclick="applyAll()" disabled>전체 적용 (모드 규칙 준수)</button>
      </div></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table><thead><tr>
        <th><input type="checkbox" id="chk-all" style="width:auto" onclick="toggleAll(this)"></th>
        <th class="sortable" data-k="name">${UNIT}</th><th class="sortable" data-k="category">분류</th>
        <th class="num sortable" data-k="blended">블렌딩ROAS</th><th class="num sortable" data-k="adjustedTarget">보정목표</th>
        <th class="sortable" data-k="isCore">핵심</th><th class="sortable" data-k="verdict">판정</th>
        <th class="num sortable" data-k="prevBid">현재</th><th class="num sortable" data-k="calcBid">권장</th>
        <th class="num sortable" data-k="delta">변경폭</th><th>비고</th>
      </tr></thead><tbody id="pv-body"><tr><td colspan="11" class="empty">미리보기를 실행해주세요.</td></tr></tbody></table></div>
    </div>
    <script>
    var PV=[];
    async function runSync(){
      var b=document.getElementById('btn-sync'),s=document.getElementById('sync-status');
      b.disabled=true;s.innerHTML='<span class="spinner"></span> 동기화 중... (소재 수에 따라 수 분 소요)';
      try{
        var j=await api('${BASE}/api/sync',{});
        s.textContent=j.ok?('완료: ${UNIT} '+j.synced+'개, 성과수집 '+j.statOk+'건 (실패 '+j.statFail+')'):('오류: '+j.error);
        if(j.ok)loadPreview();
      }catch(e){s.textContent='오류: '+e.message;}
      b.disabled=false;
    }
    async function loadPreview(){
      document.getElementById('pv-body').innerHTML='<tr><td colspan="11" class="empty"><span class="spinner"></span> 계산 중...</td></tr>';
      var j=await api('${BASE}/api/run/compute',{});
      if(!j.ok){document.getElementById('pv-body').innerHTML='<tr><td colspan="11" class="empty">'+(j.error||'오류')+'</td></tr>';return;}
      PV=j.rows.map(function(r){r.delta=r.prevBid>0?((r.calcBid-r.prevBid)/r.prevBid*100):0;return r;});
      renderPv();
      document.getElementById('btn-apply-sel').disabled=false;
      document.getElementById('btn-apply-all').disabled=false;
    }
    var PV_K='',PV_DIR=-1;
    var CATS=${JSON.stringify(logic.CATEGORIES)};
    document.querySelectorAll('th.sortable').forEach(function(th){th.onclick=function(){
      var k=th.dataset.k;
      if(PV_K===k){PV_DIR=-PV_DIR;}else{PV_K=k;PV_DIR=-1;}
      document.querySelectorAll('th.sortable').forEach(function(t){t.textContent=t.textContent.replace(/ [▲▼]$/,'');});
      th.textContent=th.textContent.replace(/ [▲▼]$/,'')+(PV_DIR<0?' ▼':' ▲');
      renderPv();
    };});
    function pvRows(){
      var q=(document.getElementById('pv-q').value||'').toLowerCase();
      var rows=PV.filter(function(r){return !q||(r.name+' '+r.campaignName).toLowerCase().indexOf(q)!==-1;});
      if(PV_K){
        var strKeys={name:1,category:1,verdict:1};
        rows=rows.slice().sort(function(a,b){
          var x=a[PV_K],y=b[PV_K];
          if(strKeys[PV_K])return String(x||'').localeCompare(String(y||''),'ko')*(-PV_DIR);
          x=(x==null||x===false)?-Infinity:(x===true?1:x);y=(y==null||y===false)?-Infinity:(y===true?1:y);
          return (y-x)*(PV_DIR<0?1:-1);});
      }
      return rows;
    }
    function catCell(r){
      return '<select onchange="catChange('+r.materialId+',this)" style="width:100px;padding:5px 8px;font-size:12px">'
        +CATS.map(function(c){return '<option '+(r.category===c?'selected':'')+'>'+c+'</option>';}).join('')+'</select>';
    }
    async function catChange(id,sel){
      var mats={};mats[id]={category:sel.value};
      var j=await api('${BASE}/api/settings/materials',{materials:mats});
      if(j.ok){toast('분류 저장 완료 — 판정은 미리보기 새로고침 시 반영');var r=PV.find(function(x){return x.materialId===id});if(r)r.category=sel.value;}
      else toast(j.error||'저장 실패',true);
    }
    function fnum(n){return n==null?'-':Math.round(n).toLocaleString('ko-KR');}
    function froas(r){return r==null?'-':(r*100).toFixed(0)+'%';}
    function vbadge(v){var cls=v==='증액'?'b-up':v==='감액'?'b-down':(v==='데이터부족'||v.indexOf('감액보류')===0)?'b-warn':(v.indexOf('유지-')===0?'b-blue':'b-keep');return '<span class="badge '+cls+'">'+v+'</span>';}
    function renderPv(){
      var LIST=pvRows();
      document.getElementById('pv-body').innerHTML=LIST.length?LIST.map(function(r){
        var delta=r.prevBid>0?((r.calcBid-r.prevBid)/r.prevBid*100):0;
        var changeable=r.adjId&&(r.verdict==='증액'||r.verdict==='감액')&&r.status==='pending';
        var forceAppr=Math.abs(delta)>${Math.round(settings.force_approval_delta * 100)};
        var isHold=r.verdict.indexOf('감액보류')===0;
        return '<tr>'
        +'<td>'+(changeable?'<input type="checkbox" class="pv-chk" value="'+r.adjId+'" style="width:auto">':'')+'</td>'
        +'<td><b>'+r.name+'</b><br><span style="color:#94a3b8;font-size:11px">'+r.campaignName+'</span></td>'
        +'<td>'+catCell(r)+'</td><td class="num">'+froas(r.blended)+'</td><td class="num">'+froas(r.adjustedTarget)+'</td>'
        +'<td>'+(r.isCore?'<span class="badge b-core">핵심</span>':'')+'</td><td>'+vbadge(r.verdict)+'</td>'
        +'<td class="num">'+fnum(r.prevBid)+'</td><td class="num" style="font-weight:700">'+fnum(r.calcBid)+'</td>'
        +'<td class="num" style="color:'+(delta>0?'#059669':delta<0?'#dc2626':'#94a3b8')+'">'+(delta?delta.toFixed(1)+'%':'-')+'</td>'
        +'<td style="font-size:11px;color:#94a3b8">'+(isHold?'승인함에서만 처리 가능':'')+(forceAppr&&changeable?'±20% 초과 — 승인 필수':'')+(r.note&&!isHold?' '+r.note:'')+(isHold&&r.note?'<br>'+r.note:'')+(r.status&&r.status!=='pending'&&r.status!=='skipped'&&r.status!=='hold_volume'?' ['+r.status+']':'')+'</td></tr>';
      }).join(''):'<tr><td colspan="11" class="empty">데이터 없음</td></tr>';
    }
    function toggleAll(cb){document.querySelectorAll('.pv-chk').forEach(function(c){c.checked=cb.checked;});}
    async function applySelected(){
      var ids=Array.prototype.slice.call(document.querySelectorAll('.pv-chk:checked')).map(function(c){return parseInt(c.value)});
      if(!ids.length){toast('적용할 건을 선택해주세요',true);return;}
      if(!confirm(ids.length+'건을 즉시 API 반영할까요?'))return;
      var j=await api('${BASE}/api/run/apply',{ids:ids});
      toast(j.ok?('적용 '+j.applied+'건, 실패 '+j.failed+'건'):(j.error||'오류'),!j.ok);
      loadPreview();
    }
    async function applyAll(){
      if(!confirm('전체 실행: 모드 규칙(자동/승인, ±20% 안전장치)에 따라 처리합니다. 진행할까요?'))return;
      var j=await api('${BASE}/api/run/weekly',{});
      toast(j.ok?('자동적용 '+j.applied+'건 / 승인대기 '+j.pending+'건 / 실패 '+j.failed+'건'):(j.error||'오류'),!j.ok);
      loadPreview();
    }
    // 페이지 진입 시 마지막 수집 데이터 기준으로 미리보기 자동 로드 (재수집 전까지 유지)
    loadPreview();
    </script>
  `;
  res.send(appLayout(req, '조정 실행', content, 'run', { accounts, account, user, pendingCount: pend }));
});

router.post('/api/sync', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await getCreds(req, account.id);
    if (!creds) return res.json({ ok: false, error: PINNED_CUSTOMER_ID ? 'API 자격증명이 없습니다. 설정 > API 연동 탭에서 등록해주세요.' : 'API 자격증명이 없습니다. AUTO REPORT > API 설정에서 마케터 API를 등록해주세요.' });
    const sync = await collector.syncMaterials(account, creds);
    const stats = await collector.collectWeeklyStats(account, creds);
    await bidDb.audit(account.id, req.session.userName, '소재 동기화·성과 수집', { synced: sync.synced, statOk: stats.ok, statFail: stats.fail });
    res.json({ ok: true, synced: sync.synced, statOk: stats.ok, statFail: stats.fail });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/run/compute', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const { weekStart, rows } = await engine.computeWeekly(account, { save: true });
    const adjs = await bidDb.getAdjustments(account.id, { weekStart, limit: 2000 });
    const adjMap = {};
    for (const a of adjs) adjMap[a.material_id] = a;
    res.json({
      ok: true, weekStart,
      rows: rows.map(r => ({
        materialId: r.materialId, adjId: adjMap[r.materialId]?.id || null, status: adjMap[r.materialId]?.status || '',
        name: r.material.name, campaignName: r.material.campaign_name, category: r.material.category,
        blended: r.blendedRoas, adjustedTarget: r.adjustedTarget, isCore: r.isCore,
        verdict: r.verdict, prevBid: r.prevBid, calcBid: r.calcBid, note: r.note || '',
      })),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/run/apply', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await getCreds(req, account.id);
    if (!creds) return res.json({ ok: false, error: 'API 자격증명 없음' });
    const ids = (req.body.ids || []).slice(0, 500);
    let applied = 0, failed = 0;
    for (const id of ids) {
      const r = await engine.applyAdjustment(account, creds, id, { auto: false, actor: req.session.userName || 'admin' });
      if (r.ok && !r.skipped) applied++;
      else if (!r.ok) failed++;
    }
    res.json({ ok: true, applied, failed });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/run/weekly', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await getCreds(req, account.id);
    if (!creds) return res.json({ ok: false, error: 'API 자격증명 없음' });
    const r = await engine.runWeekly(account, creds, { actor: req.session.userName || 'admin' });
    res.json({ ok: true, ...r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 일간 알림 수동 대응 (±3% 즉시 적용)
router.post('/api/alerts/adjust', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await getCreds(req, account.id);
    if (!creds) return res.json({ ok: false, error: 'API 자격증명 없음' });
    const rate = Math.max(-0.03, Math.min(0.03, parseFloat(req.body.rate) || 0));
    if (!rate) return res.json({ ok: false, error: '조정률 오류' });
    const created = await engine.createManualAdjustment(account, req.body.materialId, rate, {
      actor: req.session.userName || 'admin', note: '일간 트리거 수동 대응',
    });
    if (!created.ok) return res.json(created);
    const r = await engine.applyAdjustment(account, creds, created.id, { auto: false, actor: req.session.userName || 'admin' });
    if (r.ok && req.body.alertId) await bidDb.resolveAlert(req.body.alertId, account.id);
    res.json(r.ok ? { ok: true, appliedBid: created.calcBid } : r);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/alerts/resolve', requireLogin, requireMaster, async (req, res) => {
  const { account } = await getSelectedAccount(req);
  if (!account) return res.json({ ok: false });
  await bidDb.resolveAlert(req.body.id, account.id);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════
//  승인함 (광고주 접근 가능)
// ═══════════════════════════════════════════════════════════════════
router.get('/approvals', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const pendings = (await bidDb.getAdjustments(account.id, { statusIn: ['pending', 'hold_volume'], limit: 500 }))
    .filter(a => [logic.VERDICT.UP, logic.VERDICT.DOWN, logic.VERDICT.DOWN_HOLD].includes(a.verdict));
  const failed = await bidDb.getAdjustments(account.id, { status: 'failed', limit: 100 });
  const pend = pendings.length;

  const rowsHtml = pendings.map(a => {
    const delta = a.prev_bid > 0 ? ((a.calc_bid - a.prev_bid) / a.prev_bid * 100) : 0;
    const regAt = a.created_at ? new Date(a.created_at).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
    return `<tr>
      <td><input type="checkbox" class="ap-chk" value="${a.id}" style="width:auto"></td>
      <td style="white-space:nowrap;font-size:12px;color:#64748b">${regAt}</td>
      <td><b>${escHtml(a.material_name)}</b><br><span style="color:#94a3b8;font-size:11px">${escHtml(a.campaign_name)} · ${escHtml(a.adgroup_name)}</span></td>
      <td>${escHtml(a.category)}</td>
      <td>${verdictBadge(a.verdict)}${a.is_core ? ' <span class="badge b-core">핵심</span>' : ''}${a.status === 'hold_volume' ? '<br>' + statusBadge(a.status) : ''}</td>
      <td style="font-size:12px;color:#475569">블렌딩 <b>${fmtRoas(a.blended_roas)}</b> vs 목표 <b>${fmtRoas(a.adjusted_target)}</b>${a.note ? `<br><span style="color:#b45309">${escHtml(a.note)}</span>` : ''}</td>
      <td class="num">${fmtNum(a.prev_bid)}원</td>
      <td class="num" style="font-weight:700;color:${delta > 0 ? '#059669' : '#dc2626'}">${fmtNum(a.calc_bid)}원 (${delta > 0 ? '+' : ''}${delta.toFixed(1)}%)</td>
      <td style="white-space:nowrap">
        <button class="btn btn-green btn-sm" onclick="decide([${a.id}],'approve')">승인</button>
        <button class="btn btn-outline btn-sm" onclick="decide([${a.id}],'reject')">반려</button>
      </td></tr>`;
  }).join('');

  const failedHtml = failed.length ? `
    <div class="card"><div class="card-header"><span class="card-title">❌ 적용 실패 (재시도 필요)</span></div>
    <div class="tbl-wrap" style="border:none;border-radius:0"><table>
      <tr><th>${UNIT}</th><th class="num">이전</th><th class="num">목표 입찰가</th><th>오류</th><th></th></tr>
      ${failed.map(a => `<tr><td><b>${escHtml(a.material_name)}</b></td>
        <td class="num">${fmtNum(a.prev_bid)}원</td><td class="num">${fmtNum(a.calc_bid)}원</td>
        <td style="font-size:11px;color:#dc2626;max-width:340px">${escHtml((a.api_response || '').slice(0, 200))}</td>
        <td>${isClient(req) ? '' : `<button class="btn btn-outline btn-sm" onclick="decide([${a.id}],'approve')">재시도</button>`}</td></tr>`).join('')}
    </table></div></div>` : '';

  const content = `
    <div class="alert alert-info">승인 즉시 네이버 API로 입찰가가 반영됩니다. 각 건의 판정 근거(블렌딩 ROAS vs 보정목표)를 확인 후 승인해주세요.
      <b>감액보류(볼륨하락)</b> 건은 매출볼륨이 이미 하락 중인 소재로, auto 모드여도 자동 적용되지 않으며 승인된 소재만 입찰가가 수정됩니다. (반려 시 현재 입찰가 유지)</div>
    <div class="card"><div class="card-header"><span class="card-title">승인 대기 (${pendings.length}건)</span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-green btn-sm" onclick="bulk('approve')">선택 일괄 승인</button>
        <button class="btn btn-outline btn-sm" onclick="bulk('reject')">선택 일괄 반려</button>
      </div></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table>
        <thead><tr><th><input type="checkbox" style="width:auto" onclick="document.querySelectorAll('.ap-chk').forEach(c=>c.checked=this.checked)"></th>
        <th>등록일</th><th>${UNIT}</th><th>분류</th><th>판정</th><th>근거</th><th class="num">현재</th><th class="num">권장 (변경폭)</th><th>처리</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="9" class="empty">승인 대기 건이 없습니다.</td></tr>'}</tbody>
      </table></div></div>
    ${failedHtml}
    <script>
    async function decide(ids,action){
      if(action==='approve'&&!confirm(ids.length+'건 승인 → 즉시 입찰가를 변경합니다. 진행할까요?'))return;
      var j=await api('${BASE}/api/approvals/decide',{ids:ids,action:action});
      if(j.ok){toast(action==='approve'?('승인·적용 '+j.applied+'건 완료'+(j.failed?', 실패 '+j.failed+'건':'')):'반려 처리 완료');setTimeout(function(){location.reload()},800);}
      else toast(j.error||'오류',true);
    }
    function bulk(action){
      var ids=Array.prototype.slice.call(document.querySelectorAll('.ap-chk:checked')).map(function(c){return parseInt(c.value)});
      if(!ids.length){toast('선택된 건이 없습니다',true);return;}
      decide(ids,action);
    }
    </script>
  `;
  res.send(appLayout(req, '승인함', content, 'approvals', { accounts, account, user, pendingCount: pend }));
});

router.post('/api/approvals/decide', requireLogin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const action = req.body.action === 'approve' ? 'approve' : 'reject';
    const ids = (req.body.ids || []).slice(0, 500);
    const actor = (req.session.userName || '') + (isClient(req) ? ' (광고주)' : '');

    if (action === 'reject') {
      for (const id of ids) {
        const adj = await bidDb.getAdjustmentById(id, account.id);
        if (!adj || !['pending', 'hold_volume', 'failed'].includes(adj.status)) continue;
        await bidDb.setAdjustmentStatus(id, account.id, { status: 'rejected', approvedBy: actor });
        await bidDb.audit(account.id, actor, '조정 반려', { material: adj.material_name, from: adj.prev_bid, to: adj.calc_bid });
      }
      return res.json({ ok: true });
    }

    // 승인 → 즉시 API 반영 (viewer도 부여된 광고주의 소유자 자격증명 사용)
    const creds = await getCreds(req, account.id);
    if (!creds) return res.json({ ok: false, error: 'API 자격증명 없음' });
    let applied = 0, failedCnt = 0;
    for (const id of ids) {
      const adj = await bidDb.getAdjustmentById(id, account.id);
      if (!adj || !['pending', 'failed'].includes(adj.status)) continue;
      const r = await engine.applyAdjustment(account, creds, id, { auto: false, actor });
      if (r.ok && !r.skipped) applied++;
      else if (!r.ok) failedCnt++;
    }
    res.json({ ok: true, applied, failed: failedCnt });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
//  히스토리
// ═══════════════════════════════════════════════════════════════════
router.get('/history', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const pend = await pendingCount(account.id);
  const settingHist = await bidDb.getSettingHistory(account.id, 50);
  const monthly = await bidDb.getMonthlyReports(account.id, 6);

  const monthlyHtml = monthly.length ? monthly.map(mr => {
    let p = {};
    try { p = JSON.parse(mr.payload); } catch (e) {}
    const targets = p.reviewTargets || [];
    return `<div style="margin-bottom:14px"><b>${escHtml(mr.month)}</b> — 4주 연속 증액 ${p.consecUp?.length || 0}개 · 4주 연속 감액 ${p.consecDown?.length || 0}개
      ${targets.length ? `<div class="tbl-wrap" style="margin-top:8px;max-height:220px"><table><tr><th>소재</th><th>분류</th><th class="num">목표ROAS</th><th>사유</th>${isClient(req) ? '' : '<th>수동 조정 (±15%)</th>'}</tr>
      ${targets.map(t => `<tr><td>${escHtml(t.name)}</td><td>${escHtml(t.category)}</td><td class="num">${fmtRoas(t.target_roas)}</td><td style="font-size:11.5px;color:#64748b">${escHtml(t.reason)}</td>
      ${isClient(req) ? '' : `<td><button class="btn btn-outline btn-sm" onclick="manual(${t.id},0.15)">+15%</button> <button class="btn btn-outline btn-sm" onclick="manual(${t.id},-0.15)">-15%</button></td>`}</tr>`).join('')}
      </table></div>` : '<span style="color:#94a3b8;font-size:12px"> — 재검토 대상 없음</span>'}</div>`;
  }).join('') : '<div class="empty" style="padding:16px">월간 리포트가 아직 없습니다. (매월 1일 자동 생성)</div>';

  const content = `
    <div class="toolbar">
      <input id="h-q" placeholder="${UNIT} 검색..." style="width:220px">
      <span style="flex:1"></span>
      <button class="btn btn-outline btn-sm" onclick="loadHist()">새로고침</button>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">조정 내역 (승인 완료 — 입찰가가 실제 조정된 기록)</span>
      <span style="font-size:12px;color:#94a3b8">승인 후 적용 + 자동 적용 건만 표시됩니다</span></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table><thead><tr>
        <th>주차</th><th>${UNIT}</th><th>판정</th><th class="num">이전</th><th class="num">계산</th><th class="num">적용</th>
        <th class="num">블렌딩ROAS</th><th>상태</th><th>승인자</th><th>적용시각</th>
      </tr></thead><tbody id="h-body"><tr><td colspan="10" class="empty"><span class="spinner"></span></td></tr></tbody></table></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">📈 ${UNIT}별 입찰가 변화 타임라인</span>
      <div style="position:relative;width:300px">
        <input id="tl-q" placeholder="${UNIT} 이름 검색..." oninput="tlSearch()" onfocus="tlSearch()" autocomplete="off">
        <div id="tl-sug" style="position:absolute;top:calc(100% + 4px);left:0;right:0;background:#fff;border:1px solid #e5e7eb;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.14);z-index:60;display:none;max-height:280px;overflow:auto"></div>
      </div></div>
      <div class="card-body" id="tl-chart"><div class="empty" style="padding:12px">소재 이름을 검색해 선택하면 입찰가 변화 차트가 표시됩니다.</div></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">🗓 월간 리포트 (목표ROAS 재검토 대상)</span></div>
      <div class="card-body">${monthlyHtml}</div></div>
    <div class="card"><div class="card-header"><span class="card-title">설정 변경 이력</span></div>
      <div class="tbl-wrap" style="border:none;border-radius:0;max-height:300px"><table>
        <tr><th>일시</th><th>항목</th><th>이전값</th><th>변경값</th><th>수정자</th></tr>
        ${settingHist.map(h => `<tr><td>${new Date(h.changed_at).toLocaleString('ko-KR')}</td><td><b>${escHtml(h.key)}</b></td>
          <td>${escHtml(h.old_value)}</td><td style="font-weight:600">${escHtml(h.new_value)}</td><td>${escHtml(h.changed_by)}</td></tr>`).join('')
          || '<tr><td colspan="5" class="empty">변경 이력 없음</td></tr>'}
      </table></div></div>
    <script>
    var HIST=[],TL_MATS=[];
    async function loadHist(){
      var r=await fetch('${BASE}/api/history').then(function(x){return x.json()});
      if(!r.ok)return;
      HIST=r.rows;renderHist();
      var seen={};TL_MATS=[];
      r.rows.forEach(function(h){if(!seen[h.materialId]){seen[h.materialId]=1;TL_MATS.push({id:h.materialId,name:h.name});}});
    }
    function fnum(n){return n==null?'-':Math.round(n).toLocaleString('ko-KR');}
    function renderHist(){
      var q=document.getElementById('h-q').value.toLowerCase();
      var rows=HIST.filter(function(h){return !q||h.name.toLowerCase().indexOf(q)!==-1});
      document.getElementById('h-body').innerHTML=rows.length?rows.map(function(h){
        return '<tr><td>'+h.week+'</td><td><b>'+h.name+'</b></td><td>'+h.verdict+'</td>'
        +'<td class="num">'+fnum(h.prevBid)+'</td><td class="num">'+fnum(h.calcBid)+'</td><td class="num">'+fnum(h.appliedBid)+'</td>'
        +'<td class="num">'+(h.blended==null?'-':(h.blended*100).toFixed(0)+'%')+'</td>'
        +'<td>'+h.statusHtml+'</td><td>'+(h.approvedBy||'-')+'</td><td style="font-size:11px">'+(h.appliedAt||'-')+'</td></tr>';
      }).join(''):'<tr><td colspan="10" class="empty">승인 완료된 조정 내역이 없습니다.</td></tr>';
    }
    document.getElementById('h-q').oninput=renderHist;
    loadHist();
    // 타임라인 소재 검색 (드롭다운 대신 검색 → 제안 목록 클릭)
    function tlSearch(){
      var q=document.getElementById('tl-q').value.trim().toLowerCase();
      var box=document.getElementById('tl-sug');
      var list=TL_MATS.filter(function(m){return !q||m.name.toLowerCase().indexOf(q)!==-1}).slice(0,15);
      if(!list.length){box.style.display='none';return;}
      box.innerHTML=list.map(function(m){
        return '<div onclick="tlPick('+m.id+',this.textContent)" style="padding:9px 12px;font-size:12.5px;cursor:pointer;border-bottom:1px solid #f8fafc" onmouseover="this.style.background=\\'#f0f9ff\\'" onmouseout="this.style.background=\\'\\'">'+m.name+'</div>';
      }).join('');
      box.style.display='block';
    }
    function tlPick(id,name){
      document.getElementById('tl-q').value=name;
      document.getElementById('tl-sug').style.display='none';
      loadTimeline(id);
    }
    document.addEventListener('click',function(e){
      if(!e.target.closest || !e.target.closest('#tl-q,#tl-sug'))document.getElementById('tl-sug').style.display='none';
    });
    async function loadTimeline(id){
      if(!id)return;
      var pts=HIST.filter(function(h){return String(h.materialId)===String(id)&&h.appliedBid}).reverse();
      var el=document.getElementById('tl-chart');
      if(!pts.length){el.innerHTML='<div class="empty" style="padding:12px">적용된 조정이 없습니다.</div>';return;}
      var W=700,H=220,P=44,max=Math.max.apply(null,pts.map(function(p){return Math.max(p.prevBid,p.appliedBid)}));
      function x(i){return P+i*(W-2*P)/Math.max(pts.length-1,1);} function y(v){return H-P-(v/max)*(H-2*P);}
      el.innerHTML='<svg viewBox="0 0 '+W+' '+H+'" style="width:100%;background:#fafcfe;border-radius:10px">'
        +'<polyline fill="none" stroke="#0ea5e9" stroke-width="2.5" points="'+pts.map(function(p,i){return x(i)+','+y(p.appliedBid)}).join(' ')+'"/>'
        +pts.map(function(p,i){return '<circle cx="'+x(i)+'" cy="'+y(p.appliedBid)+'" r="4" fill="#0ea5e9"/>'
          +'<text x="'+x(i)+'" y="'+(y(p.appliedBid)-10)+'" text-anchor="middle" font-size="10" fill="#334155">'+p.appliedBid.toLocaleString()+'</text>'
          +'<text x="'+x(i)+'" y="'+(H-P+16)+'" text-anchor="middle" font-size="10" fill="#64748b">'+p.week.slice(5)+'</text>';}).join('')+'</svg>';
    }
    async function manual(materialId,rate){
      if(!confirm((rate>0?'+15%':'-15%')+' 수동 조정안을 생성합니다. (승인함에서 승인 후 적용) 진행할까요?'))return;
      var j=await api('${BASE}/api/manual-adjust',{materialId:materialId,rate:rate});
      toast(j.ok?'조정안 생성 완료 → 승인함 확인':'오류: '+(j.error||''),!j.ok);
    }
    </script>
  `;
  res.send(appLayout(req, '히스토리', content, 'history', { accounts, account, user, pendingCount: pend }));
});

router.get('/api/history', requireLogin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    // 승인 완료되어 입찰가가 실제 조정된 기록만 (승인 후 적용 + 자동 적용)
    const rows = await bidDb.getAdjustments(account.id, { statusIn: ['applied', 'auto_applied'], limit: 800 });
    res.json({
      ok: true,
      rows: rows.map(a => ({
        id: a.id, materialId: a.material_id, name: a.material_name,
        week: wkKey(a.week_start), verdict: a.verdict,
        prevBid: a.prev_bid, calcBid: a.calc_bid, appliedBid: a.applied_bid,
        blended: a.blended_roas == null ? null : parseFloat(a.blended_roas),
        status: a.status, statusHtml: statusBadge(a.status), approvedBy: a.approved_by,
        appliedAt: a.applied_at ? new Date(a.applied_at).toLocaleString('ko-KR') : '',
      })),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/manual-adjust', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const rate = Math.max(-0.15, Math.min(0.15, parseFloat(req.body.rate) || 0));
    if (!rate) return res.json({ ok: false, error: '조정률 오류' });
    const r = await engine.createManualAdjustment(account, req.body.materialId, rate, {
      actor: req.session.userName || 'admin', note: '월간 리포트 수동 조정',
    });
    res.json(r);
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
//  설정 (마스터=수정 / 광고주=열람 전용)
// ═══════════════════════════════════════════════════════════════════
// 탭별 파라미터 정의 — tip은 판정 로직에서의 역할 (툴팁 표시)
const SETTING_TAB_PARAMS = {
  blend: [
    { k: 'band_up', label: '판정 밴드 상단 (+)', tip: '블렌딩ROAS ≥ 보정목표×(1+상단)이면 증액. 곱연산 — 예: 목표 400%·상단 0.3 → 400%×1.3 = 520% 이상일 때 증액 (430%가 아님)' },
    { k: 'band_down', label: '판정 밴드 하단 (-)', tip: '블렌딩ROAS < 보정목표×(1-하단)이면 감액. 곱연산 — 예: 목표 400%·하단 0.3 → 400%×0.7 = 280% 미만일 때 감액' },
    { k: 'default_target_roas', label: '기본 목표ROAS (배수)', tip: '소재별 목표ROAS 미지정 시 사용. 5.5 = 550%. 분류 계수를 곱해 보정목표가 됩니다.' },
  ],
  volume: [
    { k: 'volume_drop_threshold', label: '볼륨하락 임계 (일반소재)', tip: '일반소재 감액 판정 시 최신주 매출 < 기준매출×(1-임계)이면 감액보류(볼륨하락) → 승인 대기. 0.10 = 10% 하락' },
    { k: 'volume_drop_threshold_core', label: '볼륨하락 임계 (핵심소재)', tip: '핵심소재에 별도 적용되는 볼륨하락 임계. 예: 0.05로 두면 핵심소재는 5%만 하락해도 감액을 보류' },
    { k: 'core_down_cap', label: '핵심소재 감액 상한', tip: '핵심소재는 분류 감액률 대신 이 상한까지만 감액. 예: 일반 규칙이 -10%여도 핵심소재는 0.05면 최대 -5%까지만. 핵심소재는 자동 분류 없이 소재별 설정에서 수동 지정' },
  ],
  limits: [
    { k: 'min_bid', label: '최저입찰가 (원)', tip: '권장입찰가가 이 값 아래로 내려가지 않습니다.' },
    { k: 'min_cost', label: '최소 데이터 기준 4주 누적비용 (원)', tip: '4주 누적비용이 이보다 작으면 데이터부족 → 판정하지 않고 유지.' },
    { k: 'rank_floor', label: '노출순위 하한 (위)', tip: '1주차 평균 노출순위가 이보다 낮으면(값이 크면) 감액을 보류하고 유지-순위저하.' },
  ],
  auto: [
    { k: 'force_approval_delta', label: '무조건 승인 필요 변경폭', tip: 'auto 모드여도 변경 폭이 이 비율을 초과하면 반드시 승인 후 적용. 0.20 = ±20%' },
    { k: 'daily_cost_mult', label: '일간 트리거 비용 배수', tip: '일 비용 > 4주 일평균 × 이 배수이면 일간 알림 후보. 2.0 = 200%' },
    { k: 'daily_roas_mult', label: '일간 트리거 ROAS 배수', tip: '당일 ROAS < 보정목표 × 이 배수이면 (비용 조건과 함께) 일간 알림 발생. 0.5 = 50%' },
  ],
};

const secTitle = (icon, title, desc) => `
    <div style="display:flex;align-items:baseline;gap:10px;margin:22px 0 10px">
      <span style="font-size:15px;font-weight:800;color:#0f172a">${icon} ${title}</span>
      <span style="font-size:12px;color:#94a3b8">${desc}</span>
    </div>`;

// API 연동 섹션 (마스터 전용) — 설정 탭 내부와 "이고진 미연동" 초기 화면에서 공용
function apiSectionHtml(credInfo) {
  return `
      ${secTitle('🔗', 'API 연동', '① 마케터 API 계정 등록(1회) → ② 광고주를 Customer ID로 연동')}
      <div class="card"><div class="card-header"><span class="card-title">🔑 네이버 검색광고 API 계정 (마케터 연동)</span></div>
        <div class="card-body">
          <p style="font-size:13px;color:#64748b;margin-bottom:12px">
            네이버 검색광고 시스템의 API 키를 등록하면, 해당 계정에 연결된 모든 광고주에 접근할 수 있습니다.
            검색광고 시스템 &gt; 도구 &gt; API 사용 관리에서 발급받으세요. <b>계정 1개당 담당자 계정은 1개만 등록됩니다.</b></p>
          ${credInfo
            ? `<div class="alert alert-ok">✅ 연동됨 — API Key <b>${escHtml(credInfo.masked)}</b>${credInfo.mgr ? ` · 매니저 Customer ID <b>${escHtml(credInfo.mgr)}</b>` : ''}</div>`
            : `<div class="alert alert-err">⛔ 미연동 — 아래에 마케터 API 계정을 등록해주세요. 등록 전에는 광고주 연동·동기화가 불가합니다.</div>`}
          <div class="form-row" style="grid-template-columns:1fr 1fr;max-width:760px">
            <div><label>API Key (액세스라이선스) *</label><input id="cred-key" placeholder="0100000000..." autocomplete="off"></div>
            <div><label>Secret Key (비밀키) *</label><input id="cred-secret" type="password" placeholder="AQAAAA..." autocomplete="new-password"></div>
            <div><label>매니저 Customer ID (내 계정 ID) * <span class="tip" title="검색광고 시스템 로그인 계정의 CUSTOMER_ID. 검증에 사용됩니다.">ⓘ</span></label><input id="cred-mgr" placeholder="예: 1484655"></div>
          </div>
          <div style="margin-top:14px;display:flex;gap:10px;align-items:center">
            <button class="btn btn-primary" id="btn-cred" onclick="saveCreds()">저장</button>
            <span style="font-size:12px;color:#94a3b8">저장 전 캠페인 목록 조회로 API 연결을 검증합니다. 검증 실패 시 저장되지 않습니다.</span>
          </div>
        </div></div>
      <div class="card"><div class="card-header"><span class="card-title">${PINNED_CUSTOMER_ID ? `➕ ${PINNED_LABEL} 광고주 연동 (Customer ID)` : '➕ 광고주 추가 (Customer ID 연동)'}</span></div>
        <div class="card-body">
          <p style="font-size:13px;color:#64748b;margin-bottom:12px">
            ${PINNED_CUSTOMER_ID
              ? `이 솔루션은 <b>${PINNED_LABEL}(${PINNED_CUSTOMER_ID})</b> 광고주 전용입니다.`
              : `광고주를 <b>Customer ID만 입력</b>해 추가합니다. Customer ID는 네이버 검색광고 센터 &gt; 도구 &gt; SA API 사용 관리 &gt; <b>검색광고 Key?</b>에서 확인한 숫자입니다.`}
            연동(추가) 성공 시 <b>소재 동기화 + 4주 성과 수집이 자동 실행</b>되어 데이터가 바로 저장되며, 어느 마스터가 연동했든 모든 마스터가 공유합니다.</p>
          <div style="display:flex;gap:10px;align-items:flex-end;max-width:640px;flex-wrap:wrap">
            <div style="flex:1;min-width:180px"><label>광고주명</label><input id="na-name" value="${PINNED_CUSTOMER_ID ? PINNED_LABEL : ''}" placeholder="예: 브랜드명" autocomplete="off"></div>
            <div style="flex:1;min-width:180px"><label>Customer ID</label><input id="na-cid" value="${PINNED_CUSTOMER_ID || ''}" placeholder="검색광고 Key에서 확인한 숫자" autocomplete="off"></div>
            <button class="btn btn-green" id="btn-connect" onclick="connectAccount()" style="white-space:nowrap">🔍 확인 및 연동</button>
          </div>
          <div style="margin-top:8px"><span id="connect-status" style="font-size:12px;color:#94a3b8">등록된 마케터 API 계정으로 접근 권한을 확인한 뒤 광고주를 연동하고 데이터를 수집합니다. (소재 수에 따라 수 분 소요)</span></div>
        </div></div>`;
}

const API_SECTION_SCRIPT = `
    async function saveCreds(){
      var key=document.getElementById('cred-key').value.trim(),sec=document.getElementById('cred-secret').value.trim();
      var mgr=document.getElementById('cred-mgr').value.trim();
      if(!key||!sec||!mgr){toast('API Key·Secret Key·매니저 Customer ID를 모두 입력해주세요',true);return;}
      var b=document.getElementById('btn-cred');b.disabled=true;b.textContent='검증 중...';
      var j=await api('${BASE}/api/settings/credentials',{api_key:key,secret_key:sec,manager_customer_id:mgr});
      b.disabled=false;b.textContent='저장';
      toast(j.ok?'마케터 API 계정 연동 완료':'오류: '+(j.error||''),!j.ok);
      if(j.ok)setTimeout(function(){location.reload()},1000);
    }
    async function connectAccount(){
      var name=document.getElementById('na-name').value.trim(),cid=document.getElementById('na-cid').value.trim();
      if(!name||!cid){toast('광고주명과 Customer ID를 입력해주세요',true);return;}
      if(!/^[0-9]+$/.test(cid)){toast('Customer ID는 숫자만 입력해주세요 (검색광고 Key에서 확인)',true);return;}
      var b=document.getElementById('btn-connect'),s=document.getElementById('connect-status');
      b.disabled=true;b.textContent='확인 중...';s.innerHTML='<span class="spinner"></span> 접근 권한 확인 및 데이터 수집 중... (수 분 소요될 수 있습니다)';
      try{
        var j=await api('${BASE}/api/settings/connect-account',{name:name,customer_id:cid});
        if(j.ok){
          s.textContent='완료: 캠페인 '+(j.campaigns==null?'-':j.campaigns)+'개 · 소재 '+j.synced+'개 동기화 · 성과수집 '+j.statOk+'건 (실패 '+j.statFail+')';
          toast('광고주 연동 + 데이터 수집 완료');
          setTimeout(function(){location.reload()},1200);
        }else{s.textContent='오류: '+(j.error||'');toast(j.error||'연동 실패',true);}
      }catch(e){s.textContent='오류: '+e.message;toast('연동 실패: '+e.message,true);}
      b.disabled=false;b.textContent='🔍 확인 및 연동';
    }`;

router.get('/settings', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);

  // 미연동 상태 처리 — 전용 앱: API 연동 화면 제공 / 범용 앱: AUTO REPORT 광고주 관리 안내
  if (!account) {
    if (isClient(req)) return res.redirect(BASE);
    if (!PINNED_CUSTOMER_ID) {
      const content = `
        <div class="alert alert-info">연동된 광고주가 없습니다. 광고주는 <b>AUTO REPORT &gt; 광고주 관리</b>에서 등록하면 이곳에 자동으로 나타납니다 (별도 연동 불필요).</div>
        <a href="/smart-sa/accounts" class="btn btn-primary">📊 AUTO REPORT 광고주 관리로 이동</a>`;
      return res.send(appLayout(req, '설정', content, 'settings', { accounts, account: null, user }));
    }
    let credInfo = null;
    try {
      const myCred = await db.getApiCredentials(req.session.userId, null);
      if (myCred && myCred.api_key) credInfo = { masked: String(myCred.api_key).slice(0, 10) + '••••••', mgr: myCred.manager_customer_id || '' };
    } catch (e) { /* 미연동 표시 */ }
    const content = `
      <div class="alert alert-info">🎯 <b>${PINNED_LABEL}(${PINNED_CUSTOMER_ID})</b> 광고주가 아직 연동되지 않았습니다. 아래에서 마케터 API 계정을 등록한 뒤 광고주를 연동해주세요.</div>
      ${apiSectionHtml(credInfo)}
      <script>${API_SECTION_SCRIPT}</script>`;
    return res.send(appLayout(req, '설정', content, 'settings', { accounts, account: null, user }));
  }

  const settings = await bidDb.getSettings(account.id);
  const rules = await bidDb.getCategoryRules(account.id);
  // 자동 비활성(동기화 미발견/유형 제외) 소재는 목록에서 숨김 — 수동 제외(enabled=0)는 상태 변경을 위해 표시
  const materials = (await bidDb.getMaterials(account.id)).filter(m => !m.auto_disabled);
  const pend = await pendingCount(account.id);
  // 소재별 4주 매출·비중 + 자동 핵심 판별 (소재별 설정 탭 표시용)
  const weeks4 = logic.last4Weeks();
  const statsMap4 = await bidDb.getWeeklyStatsMap(account.id, weeks4.map(w => w.start));
  const revMap = {}; let totalRev4 = 0;
  for (const m of materials) {
    const ws = statsMap4[m.id] || {};
    const rev = weeks4.reduce((a, w) => a + parseInt(ws[w.start]?.revenue || 0), 0);
    revMap[m.id] = rev; totalRev4 += rev;
  }
  const ro = isClient(req); // 광고주 = 열람 전용 (입력 disabled, 저장 버튼 미노출)
  const dis = ro ? 'disabled' : '';
  const blendN = Math.max(0, Math.min(100, Math.round(parseFloat(settings.blend_recent_weight) || 0)));

  // API 연동 상태 = 로그인한 마스터(마케터) 본인의 자격증명 (전용 앱에서만 표시 — 범용 앱은 AUTO REPORT 연동을 그대로 사용)
  let credInfo = null;
  if (!ro && PINNED_CUSTOMER_ID) {
    try {
      const myCred = await db.getApiCredentials(req.session.userId, null);
      if (myCred && myCred.api_key) {
        credInfo = { masked: String(myCred.api_key).slice(0, 10) + '••••••', mgr: myCred.manager_customer_id || '' };
      }
    } catch (e) { /* 미연동으로 표시 */ }
  }

  const paramInputs = (tab) => SETTING_TAB_PARAMS[tab].map(({ k, label, tip }) => `
    <div><label>${label} <span class="tip" title="${escHtml(tip)}">ⓘ</span></label>
    <input name="${k}" value="${settings[k]}" type="number" step="any" title="${escHtml(tip)}" ${dis}></div>`).join('');

  const saveBtn = (tab, label) => ro ? '' : `<button class="btn btn-primary btn-sm" onclick="saveTab('${tab}')">${label || '저장'}</button>`;

  // 섹션 도움말 버튼 (마우스 오버 시 설정값 설명 팝오버)
  const helpBtn = (title, bodyHtml) => `
    <span class="help-btn" tabindex="0">❓ 도움말<span class="help-pop"><span class="hp-title">${escHtml(title)}</span>${bodyHtml}</span></span>`;
  const paramHelp = (tab) => SETTING_TAB_PARAMS[tab].map(p => `<b>${escHtml(p.label)}</b> — ${escHtml(p.tip)}`).join('<br><br>');
  const HELP = {
    blend: helpBtn('블렌딩·판정 설정', `<b>1주차 비중 N%</b> — 블렌딩ROAS = (N%×1주차 매출 + (100-N)%×2~4주차 매출) ÷ (N%×1주차 비용 + (100-N)%×2~4주차 비용). N을 키우면 최근 성과에 민감, 줄이면 장기 추세 중심.<br><br>${paramHelp('blend')}`),
    volume: helpBtn('볼륨 보호 설정', `${paramHelp('volume')}<br><br><b>기준매출</b> — 주차 집계 월요일 기준 지난 4주 소재별 주간 매출 평균(100원 단위, 구매전환매출). 매주 월 08:00 자동 갱신.`),
    limits: helpBtn('입찰 한도·데이터 설정', paramHelp('limits')),
    rules: helpBtn('분류 규칙', `<b>목표ROAS 계수</b> — 소재 목표ROAS에 곱해 보정목표를 만듭니다. 1보다 작으면 관대(신제품 0.7 = 목표 550%→385%), 크면 엄격(비주력 1.2 = 660%).<br><br><b>증액률</b> — 증액 판정 시 입찰가 인상 폭. 0이면 증액 금지.<br><br><b>감액률</b> — 감액 판정 시 인하 폭. 0이면 감액 금지(신제품·유입확대).<br><br>분류는 소재별 설정에서 소재마다 지정하며, 판정 밴드(±10%)는 보정목표에 곱연산으로 적용됩니다.`),
    auto: helpBtn('자동화·알림 설정', `<b>조정 모드</b> — 승인(approval): 모든 조정을 승인함에서 승인해야 반영 / 자동(auto): 소폭 조정은 자동 반영. 소재별 모드가 우선.<br><br>${paramHelp('auto')}<br><br><b>크론 시각(KST)</b> — 매주 월 08:00 동기화+수집+기준매출+판정 · 매일 07:00 일간 모니터 · 매월 1일 06:00 월간 리포트.`),
    excl: helpBtn('제외 캠페인', `한 줄에 하나씩 입력합니다. 캠페인명에 <b>포함</b>(부분 일치)되면 수집·대시보드·주차별 데이터·조정 실행에서 모두 제외되고, 다음 동기화부터 수집 자체가 중단됩니다.<br><br>예: "키워드" 한 줄이면 이름에 키워드가 들어간 모든 캠페인이 제외됩니다 — 정확한 캠페인명 사용을 권장합니다.`),
    materials: helpBtn('소재별 설정', `<b>분류</b> — 분류 규칙 탭의 계수/증액률/감액률이 이 분류를 따라 적용.<br><br><b>목표ROAS</b> — 이 소재의 목표(배수, 5.5=550%). 미지정 시 기본 목표ROAS 사용.<br><br><b>모드</b> — 이 소재만 자동/승인을 다르게. 전역 따름=설정의 조정 모드.<br><br><b>상태</b> — 제외하면 판정·조정 대상에서 빠짐.<br><br><b>핵심</b> — 수동 지정만. 핵심소재는 감액 최대 ${Math.round(settings.core_down_cap * 100)}% + 핵심 전용 볼륨하락 임계 적용.<br><br><b>매출비중(4주)/기준매출</b> — 자동 계산 참고값. 핵심 지정할 소재 선정에 활용.`),
  };

  const rulesRows = logic.CATEGORIES.map(c => {
    const r = rules[c];
    return `<tr><td><b>${c}</b></td>
      <td><input class="rule-in" data-cat="${c}" data-f="coef" value="${r.coef}" type="number" step="0.1" style="width:80px" ${dis}></td>
      <td><input class="rule-in" data-cat="${c}" data-f="up" value="${r.up}" type="number" step="0.01" style="width:80px" ${dis}></td>
      <td><input class="rule-in" data-cat="${c}" data-f="down" value="${r.down}" type="number" step="0.01" style="width:80px" ${dis}></td></tr>`;
  }).join('');

  const matRows = materials.map(m => {
    const isCoreNow = m.core_override === '1'; // 핵심 = 수동 지정만
    const share = totalRev4 > 0 ? (revMap[m.id] / totalRev4 * 100) : 0;
    return `<tr>
    ${ro ? '' : `<td><input type="checkbox" class="mat-chk" value="${m.id}" style="width:auto"></td>`}
    <td><b>${escHtml(m.name)}</b><br><span style="color:#94a3b8;font-size:11px">${escHtml(m.campaign_name)} · ${escHtml(m.adgroup_name)}</span></td>
    <td><select class="mat-in" data-id="${m.id}" data-f="category" style="width:110px" ${dis}>${logic.CATEGORIES.map(c => `<option ${m.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
    <td><input class="mat-in" data-id="${m.id}" data-f="target_roas" value="${m.target_roas}" type="number" step="0.1" style="width:80px" ${dis}></td>
    <td><select class="mat-in" data-id="${m.id}" data-f="mode_override" style="width:110px" ${dis}>
      <option value="" ${!m.mode_override ? 'selected' : ''}>전역 따름</option>
      <option value="auto" ${m.mode_override === 'auto' ? 'selected' : ''}>자동</option>
      <option value="approval" ${m.mode_override === 'approval' ? 'selected' : ''}>승인</option></select></td>
    <td><select class="mat-in" data-id="${m.id}" data-f="enabled" style="width:90px" ${dis}>
      <option value="1" ${m.enabled ? 'selected' : ''}>활성</option><option value="0" ${!m.enabled ? 'selected' : ''}>제외</option></select></td>
    <td style="white-space:nowrap"><select class="mat-in" data-id="${m.id}" data-f="core_override" style="width:100px" ${dis}>
      <option value="" ${m.core_override !== '1' ? 'selected' : ''}>일반</option>
      <option value="1" ${m.core_override === '1' ? 'selected' : ''}>핵심</option></select>
      ${isCoreNow ? '<span class="badge b-core" style="margin-left:4px">핵심</span>' : ''}</td>
    <td class="num" style="${share >= 1 ? 'font-weight:700' : ''}">${totalRev4 > 0 ? share.toFixed(1) + '%' : '-'}</td>
    <td class="num">${m.baseline_weekly_revenue == null ? '<span style="color:#cbd5e1">-</span>' : fmtNum(m.baseline_weekly_revenue) + '원'}</td>
    <td class="num">${fmtNum(m.current_bid)}원</td></tr>`;
  }).join('');

  const TABS = [
    { id: 'params', title: '🧮 조정 기준' },
    { id: 'rules', title: '🗂️ 분류 규칙' },
    { id: 'auto', title: (!ro && PINNED_CUSTOMER_ID) ? '🤖 자동화·API 연동' : '🤖 자동화·알림' },
    { id: 'materials', title: `📦 ${UNIT}별 설정` },
  ];

  const content = `
    ${ro ? '<div class="alert alert-info">광고주 계정은 설정을 <b>열람만</b> 할 수 있습니다. 변경이 필요하면 담당 마케터에게 요청해주세요.</div>' : ''}
    <div class="tabs">${TABS.map((t, i) => `<button class="tab-btn ${i === 0 ? 'active' : ''}" data-tab="${t.id}" onclick="showTab('${t.id}')">${t.title}</button>`).join('')}</div>

    <!-- ① 조정 기준: 블렌딩·판정 / 볼륨 보호 / 입찰 한도·데이터 (섹션 구분) -->
    <div class="tab-pane active" id="pane-params">
      ${secTitle('🧮', '블렌딩·판정', '주차 성과를 하나의 블렌딩 ROAS로 합산해 보정목표와 비교하고 증액/감액/유지를 판정하는 기준')}
      <div class="card" id="sec-blend"><div class="card-header"><span class="card-title">블렌딩 구간 비율 (2구간)</span><div style="display:flex;gap:8px;align-items:center">${HELP.blend}${saveBtn('blend', '블렌딩·판정 저장')}</div></div>
        <div class="card-body">
          <label>1주차(최신 완료 주) 비중 N% <span class="tip" title="블렌딩ROAS = (N%×매출₁ + (100-N)%×매출₂₋₄) ÷ (N%×비용₁ + (100-N)%×비용₂₋₄). 2~4주차는 자동으로 100-N%가 됩니다.">ⓘ</span></label>
          <div style="display:flex;gap:14px;align-items:center;max-width:560px">
            <input type="range" id="bw-range" min="0" max="100" step="1" value="${blendN}" style="flex:1;padding:0" ${dis}>
            <input type="number" id="bw-num" name="blend_recent_weight" min="0" max="100" step="1" value="${blendN}" style="width:90px" ${dis}>
            <span id="bw-rest" style="font-size:13px;color:#0369a1;font-weight:700;white-space:nowrap">2~4주차 = ${100 - blendN}%</span>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid #f1f5f9"><div class="form-row" style="grid-template-columns:repeat(3,1fr)">${paramInputs('blend')}</div></div>
          <p style="font-size:12px;color:#94a3b8;margin-top:10px">비율 항목은 소수로 입력 (0.10 = 10%). 저장 즉시 다음 계산부터 반영되며 변경 이력이 기록됩니다.</p>
        </div></div>

      ${secTitle('🛡️', '볼륨 보호', '매출볼륨이 이미 하락 중인 소재를 ROAS만 보고 추가 감액하는 상황 방지 (증액은 볼륨 조건 없음)')}
      <div class="card" id="sec-volume"><div class="card-header"><span class="card-title">볼륨 보호 파라미터</span><div style="display:flex;gap:8px;align-items:center">${HELP.volume}${saveBtn('volume', '볼륨 보호 저장')}</div></div>
        <div class="card-body">
          <div class="form-row" style="grid-template-columns:repeat(3,1fr)">${paramInputs('volume')}</div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid #f1f5f9;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            ${ro ? '' : `<button class="btn btn-outline btn-sm" id="btn-baseline" onclick="recalcBaseline()">🔁 기준매출 재계산 (지난 4주 평균, 수동 실행)</button>`}
            <span style="font-size:12px;color:#94a3b8">기준매출 = 주차 집계 월요일 기준 <b>지난 4주 소재별 주간 매출 평균</b> (100원 단위 반올림, 구매전환매출). 매주 월 08:00 주간 실행 때 자동 갱신되며, 소재별 값은 <b>소재별 설정</b> 탭에서 확인할 수 있습니다.</span>
          </div>
        </div></div>

      ${secTitle('📏', '입찰 한도·데이터', '입찰가 하한과 판정에 필요한 최소 데이터 기준, 노출순위 보호선')}
      <div class="card" id="sec-limits"><div class="card-header"><span class="card-title">입찰 한도·데이터 기준</span><div style="display:flex;gap:8px;align-items:center">${HELP.limits}${saveBtn('limits', '입찰 한도 저장')}</div></div>
        <div class="card-body"><div class="form-row" style="grid-template-columns:repeat(3,1fr)">${paramInputs('limits')}</div></div></div>
    </div>

    <!-- ② 분류 규칙 -->
    <div class="tab-pane" id="pane-rules">
      <div class="tab-desc">소재 분류별 <b>[목표ROAS 계수 / 증액률 / 감액률]</b>. 계수는 목표ROAS에 곱해 보정목표를 만들고, 증액·감액률은 판정 시 입찰가 변경 폭이 됩니다.</div>
      <div class="card"><div class="card-header"><span class="card-title">분류별 규칙</span><div style="display:flex;gap:8px;align-items:center">${HELP.rules}${ro ? '' : '<button class="btn btn-primary btn-sm" onclick="saveRules()">규칙 저장</button>'}</div></div>
        <div class="tbl-wrap" style="border:none;border-radius:0"><table>
          <tr><th>분류</th><th>목표ROAS 계수</th><th>증액률</th><th>감액률</th></tr>${rulesRows}</table></div></div>
    </div>

    <!-- ③ 자동화·알림 + API 연동 (섹션 구분) -->
    <div class="tab-pane" id="pane-auto">
      ${secTitle('🤖', '자동화·알림', '조정 자동 적용 방식(auto/approval)·주기 실행(크론)·일간 알림 트리거 — 감액보류(볼륨하락) 건은 auto 모드여도 항상 승인 대기')}
      <div class="card" id="sec-auto"><div class="card-header"><span class="card-title">조정 모드 · 크론 · 알림</span><div style="display:flex;gap:8px;align-items:center">${HELP.auto}${saveBtn('auto', '자동화·알림 저장')}</div></div>
        <div class="card-body">
          <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13.5px;color:#334155;cursor:pointer">
              <input type="radio" name="adjust_mode" value="approval" style="width:auto" ${settings.adjust_mode === 'approval' ? 'checked' : ''} ${dis}> 승인 후 적용 (approval)</label>
            <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13.5px;color:#334155;cursor:pointer">
              <input type="radio" name="adjust_mode" value="auto" style="width:auto" ${settings.adjust_mode === 'auto' ? 'checked' : ''} ${dis}> 자동 적용 (auto)</label>
          </div>
          <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f1f5f9;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
            <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13.5px;color:#334155;cursor:pointer">
              <input type="checkbox" name="app_enabled" style="width:auto" ${settings.app_enabled === '1' ? 'checked' : ''} ${dis}> 이 광고주에 주기 자동 실행(크론) 사용</label>
            <span style="font-size:12px;color:#94a3b8">크론 시각(KST): 매주 월 08:00 동기화+성과 수집+기준매출 갱신+판정 · 매일 07:00 일간 모니터 · 매월 1일 06:00 월간 리포트</span>
          </div>
          <div style="margin-top:14px;padding-top:14px;border-top:1px solid #f1f5f9"><div class="form-row" style="grid-template-columns:repeat(3,1fr)">${paramInputs('auto')}</div></div>
        </div></div>

      ${(!ro && PINNED_CUSTOMER_ID) ? apiSectionHtml(credInfo) : ''}
    </div>

    <!-- ④ 소재별 설정 -->
    <div class="tab-pane" id="pane-materials">
      <div class="tab-desc">${UNIT} 단위로 분류·목표ROAS·모드·활성 여부를 관리합니다. 기준매출은 매월 1일(또는 수동 재계산) 자동 산출됩니다.</div>
      <div class="card" id="sec-excl"><div class="card-header"><span class="card-title">🚫 제외 캠페인 (수집·조정 제외)</span><div style="display:flex;gap:8px;align-items:center">${HELP.excl}${saveBtn('excl', '제외 목록 저장')}</div></div>
        <div class="card-body">
          <p style="font-size:12.5px;color:#64748b;margin-bottom:10px">한 줄에 하나씩 입력합니다. 캠페인명에 <b>포함</b>되면 대시보드 누적 데이터·주차별 데이터·조정 실행에서 제외되고, 다음 동기화부터 수집 자체가 중단됩니다.</p>
          <textarea name="excluded_campaigns" rows="5" style="font-family:inherit;resize:vertical" ${dis}>${escHtml(settings.excluded_campaigns || '')}</textarea>
        </div></div>
      <div class="card"><div class="card-header"><span class="card-title">${UNIT}별 설정 (분류·목표ROAS·모드·활성·핵심)</span><div style="display:flex;gap:8px;align-items:center">${HELP.materials}${ro ? '' : '<button class="btn btn-primary btn-sm" onclick="saveMats()">소재 설정 저장</button>'}</div></div>
        ${ro ? '' : `
        <div style="padding:12px 16px;border-bottom:1px solid #f1f5f9;display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:#f8fafc">
          <b style="font-size:12.5px;color:#334155;white-space:nowrap">✔ 선택 일괄 변경:</b>
          <select id="bulk-cat" style="width:110px"><option value="">분류 유지</option>${logic.CATEGORIES.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
          <input id="bulk-roas" type="number" step="0.1" placeholder="목표ROAS 유지" style="width:120px">
          <select id="bulk-mode" style="width:110px"><option value="">모드 유지</option><option value="__global">전역 따름</option><option value="auto">자동</option><option value="approval">승인</option></select>
          <select id="bulk-enabled" style="width:100px"><option value="">상태 유지</option><option value="1">활성</option><option value="0">제외</option></select>
          <select id="bulk-core" style="width:100px"><option value="">핵심 유지</option><option value="__none">일반</option><option value="1">핵심</option></select>
          <button class="btn btn-primary btn-sm" onclick="bulkApply()">선택 적용 + 저장</button>
          <span id="bulk-count" style="font-size:12px;color:#94a3b8"></span>
        </div>`}
        <div class="tbl-wrap" style="border:none;border-radius:0;max-height:520px"><table>
          <tr>${ro ? '' : '<th><input type="checkbox" style="width:auto" onclick="document.querySelectorAll(\'.mat-chk\').forEach(c=>c.checked=this.checked);bulkCount()"></th>'}<th>${UNIT}</th><th>분류</th><th>목표ROAS</th><th>모드</th><th>상태</th><th>핵심</th><th class="num">매출비중(4주)</th><th class="num">기준매출(주간)</th><th class="num">현재입찰가</th></tr>
          ${matRows || `<tr><td colspan="${ro ? 9 : 10}" class="empty">소재 없음 — 조정 실행에서 동기화를 먼저 해주세요.</td></tr>`}</table></div></div>
    </div>

    <script>
    function showTab(id){
      document.querySelectorAll('.tab-btn').forEach(function(b){b.classList.toggle('active',b.dataset.tab===id);});
      document.querySelectorAll('.tab-pane').forEach(function(p){p.classList.toggle('active',p.id==='pane-'+id);});
      try{history.replaceState(null,'','#'+id);}catch(e){}
    }
    (function(){var h=location.hash.replace('#','');if(h&&document.getElementById('pane-'+h))showTab(h);})();
    // 도움말 팝오버: 카드 overflow에 잘리지 않도록 화면 고정(fixed) 좌표로 표시
    document.querySelectorAll('.help-btn').forEach(function(b){
      var pop=b.querySelector('.help-pop');if(!pop)return;
      var t;
      function show(){
        clearTimeout(t);
        pop.style.display='block';
        var r=b.getBoundingClientRect();
        var w=Math.min(400,window.innerWidth-24);
        pop.style.width=w+'px';
        pop.style.left=Math.max(12,Math.min(r.right-w,window.innerWidth-w-12))+'px';
        var h=pop.offsetHeight,top=r.bottom+8;
        if(top+h>window.innerHeight-12)top=Math.max(12,r.top-h-8);
        pop.style.top=top+'px';
      }
      function hideSoon(){t=setTimeout(function(){pop.style.display='none';},200);}
      b.addEventListener('mouseenter',show);
      b.addEventListener('mouseleave',hideSoon);
      b.addEventListener('focus',show);
      b.addEventListener('blur',hideSoon);
      pop.addEventListener('mouseenter',function(){clearTimeout(t);});
      pop.addEventListener('mouseleave',hideSoon);
    });
    // N% 슬라이더 ↔ 직접입력 동기화 + 2~4주차 자동 표시
    (function(){
      var r=document.getElementById('bw-range'),n=document.getElementById('bw-num'),rest=document.getElementById('bw-rest');
      function sync(v){v=Math.max(0,Math.min(100,Math.round(parseFloat(v)||0)));r.value=v;n.value=v;rest.textContent='2~4주차 = '+(100-v)+'%';}
      if(r&&n){r.oninput=function(){sync(r.value)};n.oninput=function(){sync(n.value)};}
    })();
    async function saveTab(sec){
      var pane=document.getElementById('sec-'+sec); // 섹션(카드) 단위 저장
      var s={};
      pane.querySelectorAll('input[name],select[name],textarea[name]').forEach(function(i){
        if(i.type==='radio'){if(i.checked)s[i.name]=i.value;return;}
        if(i.type==='checkbox'){s[i.name]=i.checked?'1':'0';return;}
        s[i.name]=i.value;
      });
      var j=await api('${BASE}/api/settings/save',{settings:s});
      toast(j.ok?'저장 완료 ('+j.changed+'건 변경)':'오류: '+(j.error||''),!j.ok);
    }
    async function saveRules(){
      var rules={};
      document.querySelectorAll('.rule-in').forEach(function(i){var c=i.dataset.cat;if(!rules[c])rules[c]={};rules[c][i.dataset.f]=parseFloat(i.value)||0;});
      var j=await api('${BASE}/api/settings/rules',{rules:rules});
      toast(j.ok?'분류 규칙 저장 완료':'오류: '+(j.error||''),!j.ok);
    }
    async function saveMats(){
      var mats={};
      document.querySelectorAll('.mat-in').forEach(function(i){var id=i.dataset.id;if(!mats[id])mats[id]={};mats[id][i.dataset.f]=i.value;});
      var j=await api('${BASE}/api/settings/materials',{materials:mats});
      toast(j.ok?'소재 설정 저장 완료':'오류: '+(j.error||''),!j.ok);
    }
    function bulkCount(){
      var n=document.querySelectorAll('.mat-chk:checked').length;
      var el=document.getElementById('bulk-count');if(el)el.textContent=n?n+'개 선택됨':'';
    }
    document.querySelectorAll('.mat-chk').forEach(function(c){c.onchange=bulkCount;});
    async function bulkApply(){
      var ids=Array.prototype.slice.call(document.querySelectorAll('.mat-chk:checked')).map(function(c){return c.value});
      if(!ids.length){toast('일괄 변경할 소재를 선택해주세요',true);return;}
      var cat=document.getElementById('bulk-cat').value,roas=document.getElementById('bulk-roas').value.trim();
      var mode=document.getElementById('bulk-mode').value,en=document.getElementById('bulk-enabled').value,core=document.getElementById('bulk-core').value;
      if(!cat&&!roas&&!mode&&!en&&!core){toast('변경할 값을 하나 이상 선택해주세요',true);return;}
      if(!confirm(ids.length+'개 소재에 선택한 값을 일괄 적용하고 저장할까요?'))return;
      var mats={};
      ids.forEach(function(id){
        var o={};
        if(cat)o.category=cat;
        if(roas)o.target_roas=roas;
        if(mode)o.mode_override=(mode==='__global'?'':mode);
        if(en)o.enabled=en;
        if(core)o.core_override=(core==='__none'?'':core);
        mats[id]=o;
      });
      var j=await api('${BASE}/api/settings/materials',{materials:mats});
      toast(j.ok?('일괄 저장 완료 ('+ids.length+'개)'):'오류: '+(j.error||''),!j.ok);
      if(j.ok)setTimeout(function(){location.reload()},900);
    }
    ${(!ro && PINNED_CUSTOMER_ID) ? API_SECTION_SCRIPT : ''}
    async function recalcBaseline(){
      if(!confirm('지난 4주(주차 집계 기준) 주간 매출 평균으로 소재별 기준매출을 다시 계산합니다. 진행할까요?'))return;
      var b=document.getElementById('btn-baseline');b.disabled=true;b.textContent='계산 중...';
      var j=await api('${BASE}/api/settings/recalc-baseline',{});
      b.disabled=false;b.textContent='🔁 기준매출 재계산 (지난 4주 평균, 수동 실행)';
      toast(j.ok?('기준매출 재계산 완료 — 산출 '+j.updated+'건 / 데이터없음 '+j.noData+'건'):('오류: '+(j.error||'')),!j.ok);
      if(j.ok)setTimeout(function(){location.reload()},1200);
    }
    </script>
  `;
  res.send(appLayout(req, '설정', content, 'settings', { accounts, account, user, pendingCount: pend }));
});

router.post('/api/settings/save', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    let changed = 0;
    for (const [k, v] of Object.entries(req.body.settings || {})) {
      if (!(k in logic.DEFAULT_SETTINGS) && k !== 'app_enabled') continue;
      let val = v;
      if (k === 'blend_recent_weight') val = Math.max(0, Math.min(100, Math.round(parseFloat(v) || 0))); // 0~100 정수
      if (await bidDb.setSetting(account.id, k, val, req.session.userName || '')) changed++;
    }
    res.json({ ok: true, changed });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 기준매출 수동 재계산 (지난 4주 평균 — DB 주차 데이터 기반, API 호출 없음)
router.post('/api/settings/recalc-baseline', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const r = await engine.computeBaselines(account, { actor: req.session.userName || 'manual' });
    res.json({ ok: true, ...r });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 마케터 네이버SA API 계정 등록 (기존 솔루션 /smart-sa/api-settings 와 동일 모델 — 계정당 1개)
router.post('/api/settings/credentials', requireLogin, requireMaster, async (req, res) => {
  try {
    const api_key = String(req.body.api_key || '').trim();
    const secret_key = String(req.body.secret_key || '').trim();
    const manager_customer_id = String(req.body.manager_customer_id || '').trim();
    if (!api_key || !secret_key || !manager_customer_id) {
      return res.json({ ok: false, error: 'API Key·Secret Key·매니저 Customer ID를 모두 입력해주세요.' });
    }

    // 검증: 매니저 Customer ID로 캠페인 목록 조회 (기존 솔루션과 동일)
    try {
      const testClient = createApiClient({ apiKey: api_key, secretKey: secret_key, customerId: manager_customer_id });
      await testClient.getCampaigns();
    } catch (e) {
      return res.json({ ok: false, error: `API 연결 테스트 실패 — 키·비밀키·매니저 Customer ID를 확인해주세요: ${e.message}` });
    }

    // users 테이블 + agency_credentials 갱신 (1대1 정책 — 기존 솔루션과 동일)
    await db.updateApiCredentials(req.session.userId, api_key, secret_key, manager_customer_id);
    await bidDb.pool.query('DELETE FROM agency_credentials WHERE user_id = $1', [req.session.userId]);
    await db.addAgencyCredential(req.session.userId, { label: '기본 대행사', api_key, secret_key, manager_customer_id });
    await bidDb.audit(null, req.session.userName, '마케터 API 계정 등록', { mgr: manager_customer_id });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// 광고주 추가 (Customer ID만 입력 — 기존 솔루션 광고주 관리와 동일 모델):
// 등록된 마케터 자격증명으로 접근 확인 → 광고주 등록 → 소재 동기화 + 4주 성과 수집 자동 실행
router.post('/api/settings/connect-account', requireLogin, requireMaster, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const customer_id = String(req.body.customer_id || '').trim();
    if (!name || !customer_id) return res.json({ ok: false, error: '광고주명과 Customer ID를 입력해주세요.' });
    if (!/^[0-9]+$/.test(customer_id)) return res.json({ ok: false, error: 'Customer ID는 숫자만 입력해주세요. (검색광고 Key에서 확인한 값)' });
    if (PINNED_CUSTOMER_ID && customer_id !== PINNED_CUSTOMER_ID) {
      return res.json({ ok: false, error: `이 솔루션은 ${PINNED_LABEL}(${PINNED_CUSTOMER_ID}) 광고주 전용입니다. Customer ID를 확인해주세요.` });
    }

    // 1) 마케터 자격증명 확인
    const creds = await db.getApiCredentials(req.session.userId, null);
    if (!creds || !creds.api_key) {
      return res.json({ ok: false, error: '마케터 API 계정이 없습니다. 위의 네이버 검색광고 API 계정을 먼저 등록해주세요.' });
    }

    // 2) 접근 권한 확인: 마케터 키로 해당 Customer ID 캠페인 조회
    let campaigns = null;
    try {
      const client = createApiClient({ apiKey: creds.api_key, secretKey: creds.secret_key, customerId: customer_id });
      const list = await client.getCampaigns();
      campaigns = Array.isArray(list) ? list.length : null;
    } catch (e) {
      return res.json({ ok: false, error: `해당 Customer ID(${customer_id})에 API 접근 권한이 없습니다. 검색광고 Key의 CUSTOMER_ID인지 확인해주세요.` });
    }

    // 3) 광고주 등록 (같은 Customer ID를 이미 소유 중이면 재사용) — 자격증명은 소유자 기본 자격증명으로 자동 해석
    const accountId = await db.addSelectedAccount(req.session.userId, customer_id, name);
    if (creds.id) {
      await bidDb.pool.query('UPDATE ad_accounts SET agency_credential_id = $2 WHERE id = $1 AND agency_credential_id IS NULL', [accountId, creds.id]);
    }
    // 입찰관리 연동 마커 — 소재가 0개여도 모든 마스터에게 공유되도록 bid_settings에 기록
    await bidDb.setSetting(accountId, 'app_account', '1', req.session.userName || '');
    req.session[SEL_KEY] = accountId;

    // 4) 데이터 자동 저장: 소재 동기화 + 4주 성과 수집
    const account = await db.getAccountById(accountId, req.session.userId);
    let synced = 0, statOk = 0, statFail = 0;
    try {
      const sync = await collector.syncMaterials(account, creds);
      synced = sync.synced;
      const stats = await collector.collectWeeklyStats(account, creds);
      statOk = stats.ok; statFail = stats.fail;
    } catch (e) {
      await bidDb.audit(accountId, req.session.userName, '광고주 추가 (데이터 수집 일부 실패)', { customer_id, campaigns, error: e.message });
      return res.json({ ok: true, campaigns, synced, statOk, statFail, warn: `추가는 완료됐지만 데이터 수집 중 오류: ${e.message}` });
    }
    await bidDb.audit(accountId, req.session.userName, '광고주 추가 + 데이터 수집', { customer_id, campaigns, synced, statOk, statFail });
    res.json({ ok: true, campaigns, synced, statOk, statFail });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/settings/rules', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    for (const [cat, r] of Object.entries(req.body.rules || {})) {
      if (!logic.CATEGORIES.includes(cat)) continue;
      await bidDb.setCategoryRule(account.id, cat, { coef: r.coef, up: r.up, down: r.down }, req.session.userName || '');
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/settings/materials', requireLogin, requireMaster, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    for (const [id, m] of Object.entries(req.body.materials || {})) {
      await bidDb.updateMaterialMeta(parseInt(id), account.id, {
        category: logic.CATEGORIES.includes(m.category) ? m.category : undefined,
        target_roas: m.target_roas != null ? parseFloat(m.target_roas) : undefined,
        enabled: m.enabled != null ? parseInt(m.enabled) : undefined,
        mode_override: m.mode_override != null ? m.mode_override : undefined,
        core_override: ['', '1', '0'].includes(m.core_override) ? m.core_override : undefined,
      });
    }
    await bidDb.audit(account.id, req.session.userName, '소재 설정 일괄 변경', { count: Object.keys(req.body.materials || {}).length });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
//  광고주 초대 (마스터 전용) — 기존 솔루션 초대 구조 재사용 + 역할/만료/비활성화
// ═══════════════════════════════════════════════════════════════════
const INVITE_TTL_HOURS = 72; // 초대 링크 만료 (시간)
function inviteExpired(inv) {
  if (!inv || inv.status !== 'pending' || !inv.created_at) return false;
  return (Date.now() - new Date(inv.created_at).getTime()) > INVITE_TTL_HOURS * 60 * 60 * 1000;
}
const roleBadge = (r) => r === 'master'
  ? '<span class="badge b-core">마스터</span>' : '<span class="badge b-blue">광고주</span>';

router.get('/viewers', requireLogin, requireMaster, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const owned = await db.getOwnedAccountById(account.id, user.id);
  const pend = await pendingCount(account.id);
  if (!owned) {
    return res.send(appLayout(req, '광고주 초대', '<div class="empty">본인 소유 광고주만 초대를 관리할 수 있습니다.</div>', 'viewers', { accounts, account, user, pendingCount: pend }));
  }
  const viewers = await db.getAccountViewers(account.id, user.id);
  const msg = req.query.msg || '';

  const statusBadgeOf = (v) => {
    if (v.status === 'accepted') return '<span class="badge b-up">가입완료</span>';
    if (v.status === 'disabled') return '<span class="badge b-keep">비활성</span>';
    if (inviteExpired(v)) return '<span class="badge b-down">만료</span>';
    return '<span class="badge b-warn">대기</span>';
  };

  const content = `
    ${msg === 'invited' ? '<div class="alert alert-ok">초대 메일을 발송했습니다. (링크 유효기간 72시간)</div>' : ''}
    ${msg === 'err' ? '<div class="alert alert-err">초대 발송에 실패했습니다. 이메일 주소를 확인해주세요.</div>' : ''}
    ${msg === 'nodaou' ? '<div class="alert alert-err">다우오피스 SMTP 정보가 없습니다. 뉴먼트 솔루션 > 내 정보에서 등록해주세요.</div>' : ''}
    ${msg === 'role' ? '<div class="alert alert-ok">역할을 변경했습니다. (다음 로그인부터 적용)</div>' : ''}
    ${msg === 'active' ? '<div class="alert alert-ok">계정 상태를 변경했습니다.</div>' : ''}
    <div class="card"><div class="card-header"><span class="card-title">${escHtml(account.name)} — 초대 발송</span></div>
      <div class="card-body">
        <p style="font-size:13px;color:#64748b;margin-bottom:14px">
          <b>마스터</b>: 모든 탭 접근 + 설정 수정 + 조정 실행 + 승인 ·
          <b>광고주</b>: 대시보드·주차별 데이터·승인함·히스토리 + 승인/반려, 설정은 열람만</p>
        <form method="POST" action="${BASE}/viewers" style="display:flex;gap:10px;max-width:640px">
          <input name="email" type="email" required placeholder="이메일 (예: client@egojin.com)">
          <select name="role" style="width:130px">
            <option value="client" selected>광고주</option>
            <option value="master">마스터</option>
          </select>
          <button class="btn btn-primary" style="white-space:nowrap">✉️ 초대 발송</button>
        </form>
      </div></div>
    <div class="card"><div class="card-header"><span class="card-title">초대 현황</span></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table>
        <tr><th>이메일</th><th>이름</th><th>역할</th><th>상태</th><th>초대일</th><th>수락일</th><th>관리</th></tr>
        ${viewers.map(v => `<tr>
          <td><b>${escHtml(v.email)}</b></td><td>${escHtml(v.viewer_name || '-')}</td>
          <td>${roleBadge(v.role)}
            <form method="POST" action="${BASE}/viewers/${v.id}/role" style="display:inline-flex;gap:4px;margin-left:6px;vertical-align:middle" onsubmit="return confirm('역할을 변경할까요? (해당 계정 다음 로그인부터 적용)')">
              <select name="role" style="width:92px;padding:4px 8px;font-size:11.5px">
                <option value="client" ${v.role !== 'master' ? 'selected' : ''}>광고주</option>
                <option value="master" ${v.role === 'master' ? 'selected' : ''}>마스터</option>
              </select><button class="btn btn-outline btn-sm">변경</button></form></td>
          <td>${statusBadgeOf(v)}</td>
          <td>${v.created_at ? new Date(v.created_at).toLocaleDateString('ko-KR') : '-'}</td>
          <td>${v.accepted_at ? new Date(v.accepted_at).toLocaleDateString('ko-KR') : '-'}</td>
          <td style="white-space:nowrap">
            ${v.status !== 'accepted' && v.status !== 'disabled' ? `
              <form method="POST" action="${BASE}/viewers" style="display:inline">
                <input type="hidden" name="email" value="${escHtml(v.email)}"><input type="hidden" name="role" value="${escHtml(v.role || 'client')}">
                <button class="btn btn-outline btn-sm">재발송</button></form>` : ''}
            ${v.status === 'accepted' ? `
              <form method="POST" action="${BASE}/viewers/${v.id}/active" style="display:inline" onsubmit="return confirm('이 계정을 비활성화할까요? 즉시 접근이 차단됩니다.')">
                <input type="hidden" name="active" value="0"><button class="btn btn-outline btn-sm">비활성화</button></form>` : ''}
            ${v.status === 'disabled' ? `
              <form method="POST" action="${BASE}/viewers/${v.id}/active" style="display:inline">
                <input type="hidden" name="active" value="1"><button class="btn btn-green btn-sm">활성화</button></form>` : ''}
          </td></tr>`).join('')
          || '<tr><td colspan="7" class="empty">초대 내역이 없습니다.</td></tr>'}
      </table></div></div>
  `;
  res.send(appLayout(req, '광고주 초대', content, 'viewers', { accounts, account, user, pendingCount: pend }));
});

router.post('/viewers', requireLogin, requireMaster, async (req, res) => {
  const user = await getUser(req);
  const { account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const owned = await db.getOwnedAccountById(account.id, user.id);
  if (!owned) return res.redirect(`${BASE}/viewers`);
  const email = String(req.body.email || '').trim().toLowerCase();
  const role = req.body.role === 'master' ? 'master' : 'client';
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect(303, `${BASE}/viewers?msg=err`);
  // 초대 메일은 마스터(마케터)의 다우오피스 SMTP로 발송 (기존 솔루션과 동일)
  const smtp = await db.getSmtpCredentials(user.id);
  if (!smtp || !smtp.daou_email || !smtp.smtp_pass) return res.redirect(303, `${BASE}/viewers?msg=nodaou`);
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const inv = await db.createAccountInvite(account.id, user.id, email, token);
    if (inv) await bidDb.pool.query('UPDATE account_viewers SET role = $2 WHERE id = $1', [inv.id, role]);
    const base_url = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const inviteUrl = `${base_url}${BASE}/invite/${token}`;
    await sendInviteEmail({
      name: account.name,
      email_host: smtp.smtp_host || 'outbound.daouoffice.com',
      email_port: 465,
      email_user: smtp.daou_email,
      email_pass: smtp.smtp_pass,
    }, { to: email, accountName: `${account.name} 입찰관리`, inviteUrl, inviterName: user.name || user.username });
    await bidDb.audit(account.id, user.name, '초대 발송', { email, role: role === 'master' ? '마스터' : '광고주', ttlHours: INVITE_TTL_HOURS });
    res.redirect(303, `${BASE}/viewers?msg=invited`);
  } catch (e) {
    console.error('입찰관리 초대 발송 실패:', e.message);
    res.redirect(303, `${BASE}/viewers?msg=err`);
  }
});

// 역할 변경 (마스터/광고주) — 해당 계정의 다음 로그인(세션 재해석)부터 적용
router.post('/viewers/:vid/role', requireLogin, requireMaster, async (req, res) => {
  const role = req.body.role === 'master' ? 'master' : 'client';
  const row = await bidDb.setViewerRole(req.params.vid, req.session.userId, role);
  if (row) await bidDb.audit(row.account_id, req.session.userName, '초대 역할 변경', { email: row.email, role: role === 'master' ? '마스터' : '광고주' });
  res.redirect(303, `${BASE}/viewers?msg=role`);
});

// 계정 비활성화/재활성화 — 비활성 시 해당 광고주 접근 즉시 차단
router.post('/viewers/:vid/active', requireLogin, requireMaster, async (req, res) => {
  const active = req.body.active === '1';
  const row = await bidDb.setViewerActive(req.params.vid, req.session.userId, active);
  if (row) await bidDb.audit(row.account_id, req.session.userName, active ? '초대 계정 활성화' : '초대 계정 비활성화', { email: row.email });
  res.redirect(303, `${BASE}/viewers?msg=active`);
});

// ─── 초대 수락 (로그인 불필요) ─────────────────────────────────────
function inviteStandalone(title, inner) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
  <style>${css}</style></head><body style="background:linear-gradient(135deg,#0f172a,#1e3a5f);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="width:100%;max-width:440px">${inner}</div></body></html>`;
}

const inviteExpiredPage = () => inviteStandalone('초대', '<div class="card"><div class="card-body" style="text-align:center"><div style="font-size:36px">⏰</div><h2 style="margin:8px 0">만료된 초대 링크</h2><p style="color:#6b7280">초대 링크의 유효기간(72시간)이 지났습니다. 담당자에게 재발송을 요청해주세요.</p></div></div>');

router.get('/invite/:token', async (req, res) => {
  const inv = await db.getInviteByToken(req.params.token);
  if (!inv) return res.send(inviteStandalone('초대', '<div class="card"><div class="card-body" style="text-align:center"><div style="font-size:36px">⚠️</div><h2 style="margin:8px 0">유효하지 않은 초대 링크</h2><p style="color:#6b7280">링크가 만료되었거나 잘못되었습니다. 담당자에게 재발송을 요청해주세요.</p></div></div>'));
  if (inviteExpired(inv)) return res.send(inviteExpiredPage());
  const isMaster = inv.role === 'master';
  const existing = await db.getViewerUserByEmail(inv.email);
  res.send(inviteStandalone(inv.account_name + ' 입찰관리 초대', `
    <div class="card"><div class="card-body">
      <div style="text-align:center;margin-bottom:18px">
        <div style="font-size:32px">🎯</div>
        <h2 style="font-size:19px;font-weight:800;margin-top:6px">${escHtml(inv.account_name)} 입찰관리</h2>
        <p style="color:#6b7280;font-size:13px;margin-top:4px">${escHtml(inv.email)} 님을 <b>${isMaster ? '마스터' : '광고주'}</b> 권한으로 초대했습니다.</p>
      </div>
      <form method="post" action="${BASE}/invite/${req.params.token}">
        ${req.query.err ? '<div class="alert alert-err">' + escHtml(req.query.err) + '</div>' : ''}
        <div style="margin-bottom:12px"><label>이름</label><input name="name" value="${existing ? escHtml(existing.name) : ''}" required></div>
        <div style="margin-bottom:16px"><label>비밀번호 ${existing ? '(기존 계정)' : '(새로 설정)'}</label><input type="password" name="password" required minlength="4"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center">${existing ? '로그인하고 입찰관리 열기' : '계정 만들고 입찰관리 열기'}</button>
      </form>
      <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:14px">${isMaster
        ? '이 계정은 <b>마스터</b> 권한(설정 수정·조정 실행·승인)을 가집니다.'
        : '이 계정은 <b>조회 + 조정 승인</b> 권한을 가지며, 설정은 열람만 할 수 있습니다.'}</p>
    </div></div>`));
});

router.post('/invite/:token', async (req, res) => {
  const token = req.params.token;
  const inv = await db.getInviteByToken(token);
  const back = (err) => res.redirect(303, `${BASE}/invite/${token}?err=${encodeURIComponent(err)}`);
  if (!inv) return res.send(inviteStandalone('초대', '<div class="card"><div class="card-body" style="text-align:center"><h2>유효하지 않은 초대입니다.</h2></div></div>'));
  if (inviteExpired(inv)) return res.send(inviteExpiredPage());
  const name = String(req.body.name || '').trim();
  const password = String(req.body.password || '');
  if (!name || password.length < 4) return back('이름과 4자 이상 비밀번호를 입력해주세요.');
  try {
    let viewer = await db.getViewerUserByEmail(inv.email);
    if (viewer) {
      const auth = await db.authenticateUser(inv.email, password);
      if (!auth) return back('이미 가입된 이메일입니다. 기존 비밀번호를 입력해주세요.');
      viewer = auth;
    } else {
      viewer = await db.createViewerUser(inv.email, name, password);
    }
    await db.acceptInvite(token, viewer.id);
    await bidDb.audit(inv.account_id, name, '초대 수락', { email: inv.email, role: inv.role === 'master' ? '마스터' : '광고주' });
    req.session.userId = viewer.id;
    req.session.userName = viewer.name;
    req.session.isAdmin = false;
    req.session.approved = 1;
    req.session.role = 'viewer';
    req.session[SEL_KEY] = inv.account_id;
    req.session.bidRole = null;
    await resolveBidRole(req);
    req.session.save(() => res.redirect(303, BASE));
  } catch (e) {
    console.error('입찰관리 초대 수락 실패:', e.message);
    back('처리 중 오류가 발생했습니다. 다시 시도해주세요.');
  }
});

// ═══════════════════════════════════════════════════════════════════
//  크론 (매시 정각 tick — KST 시각으로 주간/일간/월간 분기)
// ═══════════════════════════════════════════════════════════════════
async function getCronAccounts() {
  // 어느 채널이든 크론 사용(app_enabled / pl_app_enabled)이 켜진 광고주 + 자격증명
  const r = await bidDb.pool.query(`
    SELECT DISTINCT a.*,
           COALESCE(ac.api_key, u.api_key) AS api_key,
           COALESCE(ac.secret_key, u.secret_key) AS secret_key,
           COALESCE(ac.manager_customer_id, u.manager_customer_id) AS manager_customer_id
    FROM ad_accounts a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN agency_credentials ac ON ac.id = a.agency_credential_id
    JOIN bid_settings s ON s.account_id = a.id AND s.key IN ('app_enabled', 'pl_app_enabled') AND s.value = '1'
  `);
  return r.rows.filter(a => a.api_key);
}

// 크론 tick 은 인스턴스 채널과 무관하게 두 채널(shopping/powerlink)을 모두 처리한다.
// (레거시 경로 /egojin-bid/api/cron/tick 하나로 전 채널·전 브랜드 커버, 클레임 키로 중복 방지)
router.get('/api/cron/tick', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const kst = logic.nowKST();
  const hour = kst.getUTCHours();
  const dow = kst.getUTCDay(); // 1=월
  const day = kst.getUTCDate();
  const dateStr = logic.fmtDate(kst);
  const results = [];

  try {
    const accounts = await getCronAccounts();
    for (const account of accounts) {
      const creds = { api_key: account.api_key, secret_key: account.secret_key, manager_customer_id: account.manager_customer_id };

      for (const ch of ['shopping', 'powerlink']) {
        // 채널별 크론 사용 여부 (shopping=app_enabled, powerlink=pl_app_enabled)
        const chSettings = await rawBidDb.getSettings(account.id, ch);
        if (chSettings.app_enabled !== '1') continue;
        const chEngine = channelEngine(ch);
        const kp = ch === 'powerlink' ? 'pl-' : ''; // 클레임 키 접두사 (shopping은 기존 키 유지)
        const chTag = ch === 'powerlink' ? 'PPO' : 'SPO';

        // 주간: 월요일 08시 (KST) — 동기화 + 4주 성과 수집 + 기준매출 + 판정 자동 실행
        if (dow === 1 && hour === 8) {
          const weekStart = logic.last4Weeks()[0].start;
          if (await bidDb.tryClaimCronRun(`${kp}weekly:${account.id}:${weekStart}`)) {
            try {
              const r = await chEngine.runWeekly(account, creds, { actor: 'cron' });
              results.push({ account: account.name, channel: chTag, job: 'weekly', ...r });
            } catch (e) { results.push({ account: account.name, channel: chTag, job: 'weekly', error: e.message }); }
          }
        }
        // 일간 모니터: 매일 07시 (KST) — 전일 데이터
        if (hour === 7) {
          const yesterday = logic.fmtDate(new Date(kst.getTime() - 24 * 60 * 60 * 1000));
          if (await bidDb.tryClaimCronRun(`${kp}daily:${account.id}:${yesterday}`)) {
            try {
              const r = await chEngine.runDailyMonitor(account, creds, yesterday);
              results.push({ account: account.name, channel: chTag, job: 'daily', ...r });
            } catch (e) { results.push({ account: account.name, channel: chTag, job: 'daily', error: e.message }); }
          }
        }
        // 매월 1일 06시 (KST): 월간 리포트
        if (day === 1 && hour === 6) {
          const prev = new Date(kst); prev.setUTCDate(0);
          const prevMonth = logic.fmtDate(prev).slice(0, 7);
          if (await bidDb.tryClaimCronRun(`${kp}monthly:${account.id}:${prevMonth}`)) {
            try {
              const r = await chEngine.runMonthlyReport(account, prevMonth);
              results.push({ account: account.name, channel: chTag, job: 'monthly', month: prevMonth, targets: r.reviewTargets.length });
            } catch (e) { results.push({ account: account.name, channel: chTag, job: 'monthly', error: e.message }); }
          }
        }
      }
    }
    res.json({ ok: true, kst: `${dateStr} ${hour}시`, accounts: accounts.length, results });
  } catch (e) {
    console.error('❌ 입찰관리 cron tick:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

return router;
}

module.exports = { createBidApp };
