// ═══════════════════════════════════════════════════════════════════
//  이고진 네이버SA 입찰관리 웹앱  (/egojin-bid)
//  쇼핑검색 소재 입찰가 주기 자동 조정·관리 (데스크톱 우선 UI)
//  역할: admin(운영자=마케터, 전체 설정/실행) / client(광고주 열람자, 조회+승인)
// ═══════════════════════════════════════════════════════════════════
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const crypto = require('crypto');
const { config } = require('../../config');
const db = require('../db/database');
const bidDb = require('./db');
const logic = require('./logic');
const engine = require('./engine');
const collector = require('./collector');
const { sendInviteEmail } = require('../email/sender');

const router = express.Router();
const BASE = '/egojin-bid';

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

// ─── 권한 ──────────────────────────────────────────────────────────
function isClient(req) { return req.session.role === 'viewer'; }

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect(`${BASE}/login`);
  if ((req.session.approved === 0 || req.session.approved === -1)) return res.redirect('/smart-sa/pending');
  next();
}

const forbidden = () => `<div style="font-family:Pretendard,system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;padding:30px"><div style="font-size:40px;margin-bottom:8px">🔒</div><h2 style="color:#111827;margin-bottom:8px">접근 권한이 없습니다</h2><p style="color:#6b7280;margin:0 0 20px;font-size:14px">광고주 계정은 조회·승인 기능만 이용할 수 있습니다.</p><a href="${BASE}" style="color:#0ea5e9;font-weight:600">← 대시보드로 돌아가기</a></div>`;

// 광고주(client) 허용 경로 — 그 외 전면 차단 (default deny)
function clientPathAllowed(p, method) {
  if (['/', '/login', '/logout', '/weekly', '/approvals', '/history'].includes(p)) return true;
  if (p.startsWith('/invite')) return true;
  if (p === '/api/select-account') return true;
  if (method === 'GET' && (p === '/api/weekly' || p === '/api/history' || p === '/api/material-trend')) return true;
  if (method === 'POST' && p.startsWith('/api/approvals/')) return true; // 승인/반려
  return false;
}
router.use((req, res, next) => {
  if (!isClient(req)) return next();
  if (clientPathAllowed(req.path, req.method)) return next();
  return res.status(403).send(forbidden());
});

function requireAdmin(req, res, next) {
  if (isClient(req)) return res.status(403).send(forbidden());
  next();
}

// ─── 계정 해석 ─────────────────────────────────────────────────────
async function getUser(req) {
  return db.getUserById(req.session.userId);
}

// 접근 가능한 광고주 목록: 운영자=본인 소유 전체, 광고주=열람 권한 계정
async function getAccessibleAccounts(req) {
  if (isClient(req)) return db.getViewerAccounts(req.session.userId);
  return db.getAccountsByUser(req.session.userId);
}

async function getSelectedAccount(req) {
  const accounts = await getAccessibleAccounts(req);
  if (!accounts.length) return { accounts, account: null };
  let account = accounts.find(a => String(a.id) === String(req.session.bidAccountId || ''));
  if (!account) { account = accounts[0]; req.session.bidAccountId = account.id; }
  return { accounts, account };
}

async function getCreds(req, accountId) {
  const creds = await db.getApiCredentials(req.session.userId, accountId);
  if (!creds) return null;
  return creds;
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
  .modal-bg{position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:500;display:flex;align-items:center;justify-content:center;padding:20px}
  .modal{background:#fff;border-radius:16px;max-width:760px;width:100%;max-height:86vh;overflow:auto;padding:24px}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .spinner{width:18px;height:18px;border:2px solid #e5e7eb;border-top-color:#0ea5e9;border-radius:50%;animation:spin .6s linear infinite;display:inline-block;vertical-align:middle}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media(max-width:900px){.sidebar{position:static;width:100%;min-height:0}.main{margin-left:0}.content{padding:14px}.kpis{grid-template-columns:repeat(2,1fr)}.form-row{grid-template-columns:1fr}}
`;

function layout(title, body) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)} - 이고진 입찰관리</title><style>${css}</style></head><body>${body}
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
  if (!client) {
    menu.push({ id: 'settings', label: '⚙️ 설정', href: `${BASE}/settings` });
    menu.push({ id: 'viewers', label: '✉️ 광고주 초대', href: `${BASE}/viewers` });
  }

  const acctSel = accounts.length > 1 ? `
    <div style="padding:12px 16px;border-bottom:1px solid #1e293b">
      <label style="color:#64748b;font-size:10px;text-transform:uppercase;letter-spacing:.08em">광고주 선택</label>
      <select onchange="fetch('${BASE}/api/select-account',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({accountId:this.value})}).then(function(){location.reload()})"
        style="background:#1e293b;border-color:#334155;color:#e2e8f0;font-size:12.5px;margin-top:4px">
        ${accounts.map(a => `<option value="${a.id}" ${account && String(a.id) === String(account.id) ? 'selected' : ''}>${escHtml(a.name)} (${escHtml(a.customer_id)})</option>`).join('')}
      </select>
    </div>` : '';

  return layout(title, `
  <div class="sidebar">
    <div class="sb-head">
      <div class="sb-logo">이고진 입찰관리</div>
      <div class="sb-sub">Naver SA Shopping Bid Manager</div>
    </div>
    ${acctSel}
    <div class="sb-section">메뉴</div>
    <div style="flex:1">
      ${menu.map(m => `<a href="${m.href}" class="sb-link ${activeMenu === m.id ? 'active' : ''}">${m.label}</a>`).join('')}
    </div>
    <div class="sb-foot">
      <div style="color:#94a3b8;font-size:12.5px;padding:4px 14px 8px">${escHtml(user?.name || '')} <span style="color:#475569">· ${client ? '광고주' : '운영자'}</span></div>
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
    : v === logic.VERDICT.NO_DATA ? 'b-warn' : v === logic.VERDICT.KEEP_RANK || v === logic.VERDICT.KEEP_NO_DOWN ? 'b-blue' : 'b-keep';
  return `<span class="badge ${cls}">${escHtml(v)}</span>`;
}

function statusBadge(s) {
  const map = {
    pending: ['승인 대기', 'b-warn'], approved: ['승인됨', 'b-blue'], rejected: ['반려', 'b-keep'],
    applied: ['적용 완료', 'b-up'], auto_applied: ['자동 적용', 'b-up'], failed: ['실패', 'b-down'], skipped: ['해당 없음', 'b-keep'],
  };
  const [label, cls] = map[s] || [s, 'b-keep'];
  return `<span class="badge ${cls}">${label}</span>`;
}

async function pendingCount(accountId) {
  const rows = await bidDb.getAdjustments(accountId, { status: 'pending', limit: 1000 });
  return rows.filter(r => r.verdict === logic.VERDICT.UP || r.verdict === logic.VERDICT.DOWN).length;
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
          <h1 style="font-size:22px;font-weight:800;color:#fff">이고진 입찰관리</h1>
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
  req.session.save(() => res.redirect(303, BASE));
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect(`${BASE}/login`));
});

router.post('/api/select-account', requireLogin, async (req, res) => {
  const accounts = await getAccessibleAccounts(req);
  const target = accounts.find(a => String(a.id) === String(req.body.accountId));
  if (target) req.session.bidAccountId = target.id;
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
      <div class="empty">연결된 광고주가 없습니다.${isClient(req) ? '' : ` <a href="/smart-sa/accounts" style="color:#0ea5e9;font-weight:600">뉴먼트 솔루션 &gt; 광고주 관리</a>에서 광고주를 먼저 등록해주세요.`}</div>
    `, 'dashboard', { accounts, account, user }));
  }

  const weeks = logic.last4Weeks();
  const { rows } = await engine.computeWeekly(account, { save: false });
  const pend = await pendingCount(account.id);
  const alerts = await bidDb.getAlerts(account.id, { unresolvedOnly: true, limit: 30 });

  // 최신 주차 요약
  let cost1 = 0, rev1 = 0, cost4 = 0, rev4 = 0;
  const dist = {};
  for (const r of rows) {
    cost1 += r.weekData[0].cost; rev1 += r.weekData[0].revenue;
    cost4 += r.cost4w; rev4 += r.revenue4w;
    dist[r.verdict] = (dist[r.verdict] || 0) + 1;
  }
  const blendedAll = logic.blendedRoas([
    { cost: 0, revenue: 0 }, { cost: 0, revenue: 0 }, { cost: 0, revenue: 0 }, { cost: 0, revenue: 0 },
  ]);
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
      <div class="kpi g"><div class="kpi-l">최신 완료 주 전환매출</div><div class="kpi-v">${fmtNum(rev1)}원</div><div class="kpi-s">4주 누적 ${fmtNum(rev4)}원</div></div>
      <div class="kpi p"><div class="kpi-l">가중 블렌딩 ROAS (전체)</div><div class="kpi-v">${fmtRoas(weightedBlended)}</div><div class="kpi-s">주차 가중 40/30/30</div></div>
      <div class="kpi o"><div class="kpi-l">승인 대기</div><div class="kpi-v">${pend}건</div><div class="kpi-s"><a href="${BASE}/approvals" style="color:#0ea5e9;font-weight:600">승인함 바로가기 →</a></div></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">판정 분포 (최신 주차 기준 계산)</span>
      <span style="font-size:12px;color:#94a3b8">소재 ${rows.length}개 · 데이터 기준 주 ${weeks[0].start} ~ ${weeks[0].end}</span></div>
      <div class="card-body">${distHtml || '<span class="empty" style="padding:0">데이터가 없습니다. 소재 동기화 후 성과가 수집되면 표시됩니다.</span>'}</div>
    </div>
    ${alertsHtml}
    ${!rows.length && !isClient(req) ? `<div class="alert alert-info">소재가 없습니다. <a href="${BASE}/run" style="font-weight:700;color:#0369a1">조정 실행</a> 페이지에서 "소재 동기화 + 성과 수집"을 먼저 실행해주세요.</div>` : ''}
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

  const content = `
    <div class="toolbar">
      <select id="f-cat"><option value="">전체 분류</option>${logic.CATEGORIES.map(c => `<option>${c}</option>`).join('')}</select>
      <select id="f-verdict"><option value="">전체 판정</option>${Object.values(logic.VERDICT).map(v => `<option>${v}</option>`).join('')}</select>
      <input id="f-q" placeholder="소재/캠페인 검색..." style="width:220px">
      <span style="flex:1"></span>
      <button class="btn btn-outline btn-sm" onclick="exportCsv()">📥 CSV 내보내기</button>
    </div>
    <div class="tbl-wrap"><table id="wk-table"><thead><tr>
      <th>소재</th><th>분류</th><th class="num">목표</th><th class="num">보정목표</th>
      <th class="num">1주 비용</th><th class="num">1주 매출</th><th class="num">2주 비용</th><th class="num">2주 매출</th>
      <th class="num">3~4주 비용</th><th class="num">3~4주 매출</th>
      <th class="num sortable" data-k="blended">블렌딩ROAS</th><th class="num">노출순위</th><th class="num sortable" data-k="share">매출비중</th>
      <th>핵심</th><th>판정</th><th class="num">현재입찰가</th><th class="num">권장입찰가</th>
    </tr></thead><tbody id="wk-body"><tr><td colspan="17" class="empty"><span class="spinner"></span> 불러오는 중...</td></tr></tbody></table></div>
    <div id="trend-modal" style="display:none"></div>
    <script>
    var DATA=[];
    fetch('${BASE}/api/weekly').then(function(r){return r.json()}).then(function(j){
      if(!j.ok){document.getElementById('wk-body').innerHTML='<tr><td colspan="17" class="empty">'+(j.error||'오류')+'</td></tr>';return;}
      DATA=j.rows;render();
      document.getElementById('f-cat').onchange=render;document.getElementById('f-verdict').onchange=render;
      document.getElementById('f-q').oninput=render;
      document.querySelectorAll('th.sortable').forEach(function(th){th.onclick=function(){var k=th.dataset.k;DATA.sort(function(a,b){return (b[k]||0)-(a[k]||0)});render();};});
    });
    function fnum(n){return n==null?'-':Math.round(n).toLocaleString('ko-KR');}
    function froas(r){return r==null?'-':(r*100).toFixed(0)+'%';}
    function filtered(){
      var cat=document.getElementById('f-cat').value,vd=document.getElementById('f-verdict').value,q=document.getElementById('f-q').value.toLowerCase();
      return DATA.filter(function(r){
        if(cat&&r.category!==cat)return false;
        if(vd&&r.verdict!==vd)return false;
        if(q&&(r.name+' '+r.campaignName+' '+r.adgroupName).toLowerCase().indexOf(q)===-1)return false;
        return true;});
    }
    function vbadge(v){var cls=v==='증액'?'b-up':v==='감액'?'b-down':v==='데이터부족'?'b-warn':(v.indexOf('유지-')===0?'b-blue':'b-keep');return '<span class="badge '+cls+'">'+v+'</span>';}
    function render(){
      var rows=filtered();
      document.getElementById('wk-body').innerHTML=rows.length?rows.map(function(r){
        return '<tr style="cursor:pointer" onclick="showTrend('+r.id+')">'
        +'<td><b>'+r.name+'</b><br><span style="color:#94a3b8;font-size:11px">'+r.campaignName+' · '+r.adgroupName+'</span></td>'
        +'<td>'+r.category+'</td><td class="num">'+froas(r.targetRoas)+'</td><td class="num">'+froas(r.adjustedTarget)+'</td>'
        +'<td class="num">'+fnum(r.w[0].cost)+'</td><td class="num">'+fnum(r.w[0].revenue)+'</td>'
        +'<td class="num">'+fnum(r.w[1].cost)+'</td><td class="num">'+fnum(r.w[1].revenue)+'</td>'
        +'<td class="num">'+fnum(r.w[2].cost+r.w[3].cost)+'</td><td class="num">'+fnum(r.w[2].revenue+r.w[3].revenue)+'</td>'
        +'<td class="num" style="font-weight:700">'+froas(r.blended)+'</td>'
        +'<td class="num">'+(r.rank1?r.rank1.toFixed(1):'-')+'</td>'
        +'<td class="num">'+(r.share*100).toFixed(1)+'%</td>'
        +'<td>'+(r.isCore?'<span class="badge b-core">핵심</span>':'')+'</td>'
        +'<td>'+vbadge(r.verdict)+'</td>'
        +'<td class="num">'+fnum(r.currentBid)+'원</td>'
        +'<td class="num" style="font-weight:700;color:'+(r.calcBid>r.currentBid?'#059669':r.calcBid<r.currentBid?'#dc2626':'#334155')+'">'+fnum(r.calcBid)+'원</td></tr>';
      }).join(''):'<tr><td colspan="17" class="empty">데이터 없음</td></tr>';
    }
    function exportCsv(){
      var head=['소재','캠페인','광고그룹','분류','목표ROAS','보정목표','1주비용','1주매출','2주비용','2주매출','3~4주비용','3~4주매출','블렌딩ROAS','노출순위','매출비중','핵심','판정','현재입찰가','권장입찰가'];
      var rows=filtered().map(function(r){return [r.name,r.campaignName,r.adgroupName,r.category,r.targetRoas,r.adjustedTarget,r.w[0].cost,r.w[0].revenue,r.w[1].cost,r.w[1].revenue,r.w[2].cost+r.w[3].cost,r.w[2].revenue+r.w[3].revenue,r.blended==null?'':r.blended.toFixed(3),r.rank1||'',(r.share*100).toFixed(1)+'%',r.isCore?'Y':'',r.verdict,r.currentBid,r.calcBid];});
      csvExport([head].concat(rows),'입찰조정_주차별데이터.csv');
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
        +'<rect x="'+(P+70)+'" y="12" width="10" height="10" fill="#10b981"/><text x="'+(P+86)+'" y="21" font-size="11" fill="#334155">전환매출</text></svg>';
    }
    </script>
  `;
  res.send(appLayout(req, '주차별 데이터', content, 'weekly', { accounts, account, user, pendingCount: pend }));
});

router.get('/api/weekly', requireLogin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const { rows } = await engine.computeWeekly(account, { save: false });
    const totalRev = rows.reduce((a, r) => a + r.revenue4w, 0);
    res.json({
      ok: true,
      rows: rows.map(r => ({
        id: r.materialId, name: r.material.name, campaignName: r.material.campaign_name, adgroupName: r.material.adgroup_name,
        category: r.material.category, targetRoas: r.material.target_roas,
        adjustedTarget: r.adjustedTarget, blended: r.blendedRoas,
        w: r.weekData, rank1: r.weekData[0].rank,
        share: totalRev > 0 ? r.revenue4w / totalRev : 0,
        isCore: r.isCore, verdict: r.verdict,
        currentBid: r.prevBid, calcBid: r.calcBid,
      })),
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
router.get('/run', requireLogin, requireAdmin, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const settings = await bidDb.getSettings(account.id);
  const pend = await pendingCount(account.id);
  const mats = await bidDb.getMaterials(account.id, { enabledOnly: true });

  const content = `
    <div class="alert alert-info">현재 조정 모드: <b>${settings.adjust_mode === 'auto' ? '자동 적용 (auto)' : '승인 후 적용 (approval)'}</b>
      · auto 모드여도 변경 폭 ±${Math.round(settings.force_approval_delta * 100)}% 초과 건은 무조건 승인이 필요합니다.
      모드는 <a href="${BASE}/settings" style="font-weight:700;color:#0369a1">설정</a>에서 변경.</div>
    <div class="card"><div class="card-header"><span class="card-title">1) 데이터 준비</span>
      <span style="font-size:12px;color:#94a3b8">활성 소재 ${mats.length}개</span></div>
      <div class="card-body">
        <button class="btn btn-primary" id="btn-sync" onclick="runSync()">🔄 소재 동기화 + 4주 성과 수집</button>
        <span id="sync-status" style="margin-left:10px;font-size:13px;color:#64748b"></span>
      </div></div>
    <div class="card"><div class="card-header"><span class="card-title">2) 계산 결과 미리보기 → 적용</span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-outline btn-sm" onclick="loadPreview()">미리보기 새로고침</button>
        <button class="btn btn-green btn-sm" id="btn-apply-sel" onclick="applySelected()" disabled>선택 적용</button>
        <button class="btn btn-danger btn-sm" id="btn-apply-all" onclick="applyAll()" disabled>전체 적용 (모드 규칙 준수)</button>
      </div></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table><thead><tr>
        <th><input type="checkbox" id="chk-all" style="width:auto" onclick="toggleAll(this)"></th>
        <th>소재</th><th>분류</th><th class="num">블렌딩ROAS</th><th class="num">보정목표</th><th>핵심</th><th>판정</th>
        <th class="num">현재</th><th class="num">권장</th><th class="num">변경폭</th><th>비고</th>
      </tr></thead><tbody id="pv-body"><tr><td colspan="11" class="empty">미리보기를 실행해주세요.</td></tr></tbody></table></div>
    </div>
    <script>
    var PV=[];
    async function runSync(){
      var b=document.getElementById('btn-sync'),s=document.getElementById('sync-status');
      b.disabled=true;s.innerHTML='<span class="spinner"></span> 동기화 중... (소재 수에 따라 수 분 소요)';
      try{
        var j=await api('${BASE}/api/sync',{});
        s.textContent=j.ok?('완료: 소재 '+j.synced+'개, 성과수집 '+j.statOk+'건 (실패 '+j.statFail+')'):('오류: '+j.error);
        if(j.ok)loadPreview();
      }catch(e){s.textContent='오류: '+e.message;}
      b.disabled=false;
    }
    async function loadPreview(){
      document.getElementById('pv-body').innerHTML='<tr><td colspan="11" class="empty"><span class="spinner"></span> 계산 중...</td></tr>';
      var j=await api('${BASE}/api/run/compute',{});
      if(!j.ok){document.getElementById('pv-body').innerHTML='<tr><td colspan="11" class="empty">'+(j.error||'오류')+'</td></tr>';return;}
      PV=j.rows;renderPv();
      document.getElementById('btn-apply-sel').disabled=false;
      document.getElementById('btn-apply-all').disabled=false;
    }
    function fnum(n){return n==null?'-':Math.round(n).toLocaleString('ko-KR');}
    function froas(r){return r==null?'-':(r*100).toFixed(0)+'%';}
    function vbadge(v){var cls=v==='증액'?'b-up':v==='감액'?'b-down':v==='데이터부족'?'b-warn':(v.indexOf('유지-')===0?'b-blue':'b-keep');return '<span class="badge '+cls+'">'+v+'</span>';}
    function renderPv(){
      document.getElementById('pv-body').innerHTML=PV.length?PV.map(function(r){
        var delta=r.prevBid>0?((r.calcBid-r.prevBid)/r.prevBid*100):0;
        var changeable=r.adjId&&(r.verdict==='증액'||r.verdict==='감액')&&r.status==='pending';
        var forceAppr=Math.abs(delta)>${Math.round(settings.force_approval_delta * 100)};
        return '<tr>'
        +'<td>'+(changeable?'<input type="checkbox" class="pv-chk" value="'+r.adjId+'" style="width:auto">':'')+'</td>'
        +'<td><b>'+r.name+'</b><br><span style="color:#94a3b8;font-size:11px">'+r.campaignName+'</span></td>'
        +'<td>'+r.category+'</td><td class="num">'+froas(r.blended)+'</td><td class="num">'+froas(r.adjustedTarget)+'</td>'
        +'<td>'+(r.isCore?'<span class="badge b-core">핵심</span>':'')+'</td><td>'+vbadge(r.verdict)+'</td>'
        +'<td class="num">'+fnum(r.prevBid)+'</td><td class="num" style="font-weight:700">'+fnum(r.calcBid)+'</td>'
        +'<td class="num" style="color:'+(delta>0?'#059669':delta<0?'#dc2626':'#94a3b8')+'">'+(delta?delta.toFixed(1)+'%':'-')+'</td>'
        +'<td style="font-size:11px;color:#94a3b8">'+(forceAppr&&changeable?'±20% 초과 — 승인 필수':'')+(r.status&&r.status!=='pending'&&r.status!=='skipped'?' ['+r.status+']':'')+'</td></tr>';
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
    </script>
  `;
  res.send(appLayout(req, '조정 실행', content, 'run', { accounts, account, user, pendingCount: pend }));
});

router.post('/api/sync', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    const creds = await getCreds(req, account.id);
    if (!creds) return res.json({ ok: false, error: 'API 자격증명이 없습니다. 뉴먼트 솔루션 > API 설정에서 등록해주세요.' });
    const sync = await collector.syncMaterials(account, creds);
    const stats = await collector.collectWeeklyStats(account, creds);
    await bidDb.audit(account.id, req.session.userName, '소재 동기화·성과 수집', { synced: sync.synced, statOk: stats.ok, statFail: stats.fail });
    res.json({ ok: true, synced: sync.synced, statOk: stats.ok, statFail: stats.fail });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/run/compute', requireLogin, requireAdmin, async (req, res) => {
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
        verdict: r.verdict, prevBid: r.prevBid, calcBid: r.calcBid,
      })),
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/run/apply', requireLogin, requireAdmin, async (req, res) => {
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

router.post('/api/run/weekly', requireLogin, requireAdmin, async (req, res) => {
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
router.post('/api/alerts/adjust', requireLogin, requireAdmin, async (req, res) => {
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

router.post('/api/alerts/resolve', requireLogin, requireAdmin, async (req, res) => {
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
  const pendings = (await bidDb.getAdjustments(account.id, { status: 'pending', limit: 500 }))
    .filter(a => a.verdict === logic.VERDICT.UP || a.verdict === logic.VERDICT.DOWN);
  const failed = await bidDb.getAdjustments(account.id, { status: 'failed', limit: 100 });
  const pend = pendings.length;

  const rowsHtml = pendings.map(a => {
    const delta = a.prev_bid > 0 ? ((a.calc_bid - a.prev_bid) / a.prev_bid * 100) : 0;
    return `<tr>
      <td><input type="checkbox" class="ap-chk" value="${a.id}" style="width:auto"></td>
      <td><b>${escHtml(a.material_name)}</b><br><span style="color:#94a3b8;font-size:11px">${escHtml(a.campaign_name)} · ${escHtml(a.adgroup_name)}</span></td>
      <td>${escHtml(a.category)}</td>
      <td>${verdictBadge(a.verdict)}${a.is_core ? ' <span class="badge b-core">핵심</span>' : ''}</td>
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
      <tr><th>소재</th><th class="num">이전</th><th class="num">목표 입찰가</th><th>오류</th><th></th></tr>
      ${failed.map(a => `<tr><td><b>${escHtml(a.material_name)}</b></td>
        <td class="num">${fmtNum(a.prev_bid)}원</td><td class="num">${fmtNum(a.calc_bid)}원</td>
        <td style="font-size:11px;color:#dc2626;max-width:340px">${escHtml((a.api_response || '').slice(0, 200))}</td>
        <td>${isClient(req) ? '' : `<button class="btn btn-outline btn-sm" onclick="decide([${a.id}],'approve')">재시도</button>`}</td></tr>`).join('')}
    </table></div></div>` : '';

  const content = `
    <div class="alert alert-info">승인 즉시 네이버 API로 입찰가가 반영됩니다. 각 건의 판정 근거(블렌딩 ROAS vs 보정목표)를 확인 후 승인해주세요.</div>
    <div class="card"><div class="card-header"><span class="card-title">승인 대기 (${pendings.length}건)</span>
      <div style="display:flex;gap:8px">
        <button class="btn btn-green btn-sm" onclick="bulk('approve')">선택 일괄 승인</button>
        <button class="btn btn-outline btn-sm" onclick="bulk('reject')">선택 일괄 반려</button>
      </div></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table>
        <thead><tr><th><input type="checkbox" style="width:auto" onclick="document.querySelectorAll('.ap-chk').forEach(c=>c.checked=this.checked)"></th>
        <th>소재</th><th>분류</th><th>판정</th><th>근거</th><th class="num">현재</th><th class="num">권장 (변경폭)</th><th>처리</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="8" class="empty">승인 대기 건이 없습니다.</td></tr>'}</tbody>
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
        if (!adj || !['pending', 'failed'].includes(adj.status)) continue;
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
      <select id="h-status"><option value="">전체 상태</option>
        ${['pending', 'approved', 'rejected', 'applied', 'auto_applied', 'failed', 'skipped'].map(s => `<option value="${s}">${s}</option>`).join('')}</select>
      <input id="h-q" placeholder="소재 검색..." style="width:200px">
      <span style="flex:1"></span>
      <button class="btn btn-outline btn-sm" onclick="loadHist()">새로고침</button>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">조정 내역</span></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table><thead><tr>
        <th>주차</th><th>소재</th><th>판정</th><th class="num">이전</th><th class="num">계산</th><th class="num">적용</th>
        <th class="num">블렌딩ROAS</th><th>상태</th><th>승인자</th><th>적용시각</th>
      </tr></thead><tbody id="h-body"><tr><td colspan="10" class="empty"><span class="spinner"></span></td></tr></tbody></table></div>
    </div>
    <div class="card"><div class="card-header"><span class="card-title">📈 소재별 입찰가 변화 타임라인</span>
      <select id="tl-mat" style="width:280px" onchange="loadTimeline()"><option value="">소재 선택...</option></select></div>
      <div class="card-body" id="tl-chart"><div class="empty" style="padding:12px">소재를 선택하면 입찰가 변화 차트가 표시됩니다.</div></div>
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
    var HIST=[];
    async function loadHist(){
      var st=document.getElementById('h-status').value;
      var r=await fetch('${BASE}/api/history'+(st?'?status='+st:'')).then(function(x){return x.json()});
      if(!r.ok)return;
      HIST=r.rows;renderHist();
      var sel=document.getElementById('tl-mat');
      if(sel.options.length<=1){
        var seen={};
        r.rows.forEach(function(h){if(!seen[h.materialId]){seen[h.materialId]=1;var o=document.createElement('option');o.value=h.materialId;o.textContent=h.name;sel.appendChild(o);}});
      }
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
      }).join(''):'<tr><td colspan="10" class="empty">내역 없음</td></tr>';
    }
    document.getElementById('h-q').oninput=renderHist;
    document.getElementById('h-status').onchange=loadHist;
    loadHist();
    async function loadTimeline(){
      var id=document.getElementById('tl-mat').value;
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
    const rows = await bidDb.getAdjustments(account.id, { status: req.query.status || undefined, limit: 800 });
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

router.post('/api/manual-adjust', requireLogin, requireAdmin, async (req, res) => {
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
//  설정 (운영자)
// ═══════════════════════════════════════════════════════════════════
const SETTING_LABELS = {
  w1: '블렌딩 가중치 1주차', w2: '블렌딩 가중치 2주차', w3: '블렌딩 가중치 3~4주차',
  band_up: '판정 밴드 상단 (+)', band_down: '판정 밴드 하단 (-)',
  core_share: '핵심소재 누적기여 기준', core_down_cap: '핵심소재 감액 상한',
  min_bid: '최저입찰가 (원)', min_cost: '최소 데이터 기준 4주 누적비용 (원)',
  rank_floor: '노출순위 하한 (위)', default_target_roas: '기본 목표ROAS (배수, 5.5=550%)',
  force_approval_delta: '무조건 승인 필요 변경폭', daily_cost_mult: '일간 트리거 비용 배수', daily_roas_mult: '일간 트리거 ROAS 배수',
};

router.get('/settings', requireLogin, requireAdmin, async (req, res) => {
  const user = await getUser(req);
  const { accounts, account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const settings = await bidDb.getSettings(account.id);
  const rules = await bidDb.getCategoryRules(account.id);
  const materials = await bidDb.getMaterials(account.id);
  const pend = await pendingCount(account.id);

  const paramInputs = Object.entries(SETTING_LABELS).map(([k, label]) => `
    <div><label>${label}</label><input name="${k}" value="${settings[k]}" type="number" step="any"></div>`).join('');

  const rulesRows = logic.CATEGORIES.map(c => {
    const r = rules[c];
    return `<tr><td><b>${c}</b></td>
      <td><input class="rule-in" data-cat="${c}" data-f="coef" value="${r.coef}" type="number" step="0.1" style="width:80px"></td>
      <td><input class="rule-in" data-cat="${c}" data-f="up" value="${r.up}" type="number" step="0.01" style="width:80px"></td>
      <td><input class="rule-in" data-cat="${c}" data-f="down" value="${r.down}" type="number" step="0.01" style="width:80px"></td></tr>`;
  }).join('');

  const matRows = materials.map(m => `<tr>
    <td><b>${escHtml(m.name)}</b><br><span style="color:#94a3b8;font-size:11px">${escHtml(m.campaign_name)} · ${escHtml(m.adgroup_name)}</span></td>
    <td><select class="mat-in" data-id="${m.id}" data-f="category" style="width:110px">${logic.CATEGORIES.map(c => `<option ${m.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></td>
    <td><input class="mat-in" data-id="${m.id}" data-f="target_roas" value="${m.target_roas}" type="number" step="0.1" style="width:80px"></td>
    <td><select class="mat-in" data-id="${m.id}" data-f="mode_override" style="width:110px">
      <option value="" ${!m.mode_override ? 'selected' : ''}>전역 따름</option>
      <option value="auto" ${m.mode_override === 'auto' ? 'selected' : ''}>자동</option>
      <option value="approval" ${m.mode_override === 'approval' ? 'selected' : ''}>승인</option></select></td>
    <td><select class="mat-in" data-id="${m.id}" data-f="enabled" style="width:90px">
      <option value="1" ${m.enabled ? 'selected' : ''}>활성</option><option value="0" ${!m.enabled ? 'selected' : ''}>제외</option></select></td>
    <td class="num">${fmtNum(m.current_bid)}원</td></tr>`).join('');

  const content = `
    <div class="card"><div class="card-header"><span class="card-title">조정 모드</span></div><div class="card-body">
      <div style="display:flex;gap:16px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13.5px;color:#334155;cursor:pointer">
          <input type="radio" name="mode" value="approval" style="width:auto" ${settings.adjust_mode === 'approval' ? 'checked' : ''}> 승인 후 적용 (approval)</label>
        <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13.5px;color:#334155;cursor:pointer">
          <input type="radio" name="mode" value="auto" style="width:auto" ${settings.adjust_mode === 'auto' ? 'checked' : ''}> 자동 적용 (auto)</label>
        <button class="btn btn-primary btn-sm" onclick="saveMode()">모드 저장</button>
      </div>
      <div style="margin-top:12px;padding-top:12px;border-top:1px solid #f1f5f9;display:flex;gap:12px;align-items:center">
        <label style="display:flex;align-items:center;gap:6px;margin:0;font-size:13.5px;color:#334155;cursor:pointer">
          <input type="checkbox" id="app-enabled" style="width:auto" ${settings.app_enabled === '1' ? 'checked' : ''}> 이 광고주에 주기 자동 실행(크론) 사용</label>
        <button class="btn btn-outline btn-sm" onclick="saveEnabled()">저장</button>
        <span style="font-size:12px;color:#94a3b8">매주 월 06:00 주간 조정 · 매일 07:00 모니터 · 매월 1일 월간 리포트 (KST)</span>
      </div>
    </div></div>
    <div class="card"><div class="card-header"><span class="card-title">조정 파라미터</span><button class="btn btn-primary btn-sm" onclick="saveParams()">파라미터 저장</button></div>
      <div class="card-body"><form id="param-form"><div class="form-row" style="grid-template-columns:repeat(3,1fr)">${paramInputs}</div></form>
      <p style="font-size:12px;color:#94a3b8;margin-top:10px">비율 항목은 소수로 입력 (0.10 = 10%). 저장 즉시 다음 계산부터 반영되며 변경 이력이 기록됩니다.</p></div></div>
    <div class="card"><div class="card-header"><span class="card-title">분류별 규칙 [계수 / 증액률 / 감액률]</span><button class="btn btn-primary btn-sm" onclick="saveRules()">규칙 저장</button></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table>
        <tr><th>분류</th><th>목표ROAS 계수</th><th>증액률</th><th>감액률</th></tr>${rulesRows}</table></div></div>
    <div class="card"><div class="card-header"><span class="card-title">소재별 설정 (분류·목표ROAS·모드·활성)</span><button class="btn btn-primary btn-sm" onclick="saveMats()">소재 설정 저장</button></div>
      <div class="tbl-wrap" style="border:none;border-radius:0;max-height:520px"><table>
        <tr><th>소재</th><th>분류</th><th>목표ROAS</th><th>모드</th><th>상태</th><th class="num">현재입찰가</th></tr>
        ${matRows || '<tr><td colspan="6" class="empty">소재 없음 — 조정 실행에서 동기화를 먼저 해주세요.</td></tr>'}</table></div></div>
    <script>
    async function saveMode(){
      var v=document.querySelector('input[name=mode]:checked').value;
      var j=await api('${BASE}/api/settings/save',{settings:{adjust_mode:v}});
      toast(j.ok?'모드 저장 완료':'오류',!j.ok);
    }
    async function saveEnabled(){
      var v=document.getElementById('app-enabled').checked?'1':'0';
      var j=await api('${BASE}/api/settings/save',{settings:{app_enabled:v}});
      toast(j.ok?'저장 완료':'오류',!j.ok);
    }
    async function saveParams(){
      var s={};document.querySelectorAll('#param-form input').forEach(function(i){s[i.name]=i.value;});
      var j=await api('${BASE}/api/settings/save',{settings:s});
      toast(j.ok?'파라미터 저장 완료 ('+j.changed+'건 변경)':'오류',!j.ok);
    }
    async function saveRules(){
      var rules={};
      document.querySelectorAll('.rule-in').forEach(function(i){var c=i.dataset.cat;if(!rules[c])rules[c]={};rules[c][i.dataset.f]=parseFloat(i.value)||0;});
      var j=await api('${BASE}/api/settings/rules',{rules:rules});
      toast(j.ok?'분류 규칙 저장 완료':'오류',!j.ok);
    }
    async function saveMats(){
      var mats={};
      document.querySelectorAll('.mat-in').forEach(function(i){var id=i.dataset.id;if(!mats[id])mats[id]={};mats[id][i.dataset.f]=i.value;});
      var j=await api('${BASE}/api/settings/materials',{materials:mats});
      toast(j.ok?'소재 설정 저장 완료':'오류',!j.ok);
    }
    </script>
  `;
  res.send(appLayout(req, '설정', content, 'settings', { accounts, account, user, pendingCount: pend }));
});

router.post('/api/settings/save', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    let changed = 0;
    for (const [k, v] of Object.entries(req.body.settings || {})) {
      if (!(k in logic.DEFAULT_SETTINGS) && k !== 'app_enabled') continue;
      if (await bidDb.setSetting(account.id, k, v, req.session.userName || '')) changed++;
    }
    res.json({ ok: true, changed });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/api/settings/rules', requireLogin, requireAdmin, async (req, res) => {
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

router.post('/api/settings/materials', requireLogin, requireAdmin, async (req, res) => {
  try {
    const { account } = await getSelectedAccount(req);
    if (!account) return res.json({ ok: false, error: '광고주 없음' });
    for (const [id, m] of Object.entries(req.body.materials || {})) {
      await bidDb.updateMaterialMeta(parseInt(id), account.id, {
        category: logic.CATEGORIES.includes(m.category) ? m.category : undefined,
        target_roas: m.target_roas != null ? parseFloat(m.target_roas) : undefined,
        enabled: m.enabled != null ? parseInt(m.enabled) : undefined,
        mode_override: m.mode_override != null ? m.mode_override : undefined,
      });
    }
    await bidDb.audit(account.id, req.session.userName, '소재 설정 일괄 변경', { count: Object.keys(req.body.materials || {}).length });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════
//  광고주 초대 (운영자) — 기존 솔루션과 동일한 초대 구조 재사용
// ═══════════════════════════════════════════════════════════════════
router.get('/viewers', requireLogin, requireAdmin, async (req, res) => {
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

  const content = `
    ${msg === 'invited' ? '<div class="alert alert-ok">초대 메일을 발송했습니다.</div>' : ''}
    ${msg === 'err' ? '<div class="alert alert-err">초대 발송에 실패했습니다. 이메일 주소를 확인해주세요.</div>' : ''}
    ${msg === 'nodaou' ? '<div class="alert alert-err">다우오피스 SMTP 정보가 없습니다. 뉴먼트 솔루션 > 내 정보에서 등록해주세요.</div>' : ''}
    ${msg === 'revoked' ? '<div class="alert alert-ok">열람 권한을 취소했습니다.</div>' : ''}
    <div class="card"><div class="card-header"><span class="card-title">${escHtml(account.name)} — 광고주 초대</span></div>
      <div class="card-body">
        <p style="font-size:13px;color:#64748b;margin-bottom:14px">초대된 광고주는 이메일로 계정을 만들고 <b>대시보드 조회 + 조정 승인/반려</b>만 할 수 있습니다. (설정·실행 불가)</p>
        <form method="POST" action="${BASE}/viewers" style="display:flex;gap:10px;max-width:520px">
          <input name="email" type="email" required placeholder="광고주 이메일 (예: client@egojin.com)">
          <button class="btn btn-primary" style="white-space:nowrap">✉️ 초대 발송</button>
        </form>
      </div></div>
    <div class="card"><div class="card-header"><span class="card-title">초대 현황</span></div>
      <div class="tbl-wrap" style="border:none;border-radius:0"><table>
        <tr><th>이메일</th><th>이름</th><th>상태</th><th>초대일</th><th>수락일</th><th></th></tr>
        ${viewers.map(v => `<tr>
          <td><b>${escHtml(v.email)}</b></td><td>${escHtml(v.viewer_name || '-')}</td>
          <td>${v.status === 'accepted' ? '<span class="badge b-up">수락됨</span>' : '<span class="badge b-warn">대기 중</span>'}</td>
          <td>${v.created_at ? new Date(v.created_at).toLocaleDateString('ko-KR') : '-'}</td>
          <td>${v.accepted_at ? new Date(v.accepted_at).toLocaleDateString('ko-KR') : '-'}</td>
          <td><form method="POST" action="${BASE}/viewers/${v.id}/revoke" onsubmit="return confirm('열람 권한을 취소할까요?')">
            <button class="btn btn-outline btn-sm">권한 취소</button></form></td></tr>`).join('')
          || '<tr><td colspan="6" class="empty">초대 내역이 없습니다.</td></tr>'}
      </table></div></div>
  `;
  res.send(appLayout(req, '광고주 초대', content, 'viewers', { accounts, account, user, pendingCount: pend }));
});

router.post('/viewers', requireLogin, requireAdmin, async (req, res) => {
  const user = await getUser(req);
  const { account } = await getSelectedAccount(req);
  if (!account) return res.redirect(BASE);
  const owned = await db.getOwnedAccountById(account.id, user.id);
  if (!owned) return res.redirect(`${BASE}/viewers`);
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.redirect(303, `${BASE}/viewers?msg=err`);
  // 초대 메일은 운영자(마케터)의 다우오피스 SMTP로 발송 (기존 솔루션과 동일)
  const smtp = await db.getSmtpCredentials(user.id);
  if (!smtp || !smtp.daou_email || !smtp.smtp_pass) return res.redirect(303, `${BASE}/viewers?msg=nodaou`);
  try {
    const token = crypto.randomBytes(24).toString('hex');
    await db.createAccountInvite(account.id, user.id, email, token);
    const base_url = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
    const inviteUrl = `${base_url}${BASE}/invite/${token}`;
    await sendInviteEmail({
      name: account.name,
      email_host: smtp.smtp_host || 'outbound.daouoffice.com',
      email_port: 465,
      email_user: smtp.daou_email,
      email_pass: smtp.smtp_pass,
    }, { to: email, accountName: `${account.name} 입찰관리`, inviteUrl, inviterName: user.name || user.username });
    await bidDb.audit(account.id, user.name, '광고주 초대 발송', { email });
    res.redirect(303, `${BASE}/viewers?msg=invited`);
  } catch (e) {
    console.error('입찰관리 초대 발송 실패:', e.message);
    res.redirect(303, `${BASE}/viewers?msg=err`);
  }
});

router.post('/viewers/:vid/revoke', requireLogin, requireAdmin, async (req, res) => {
  await db.revokeAccountViewer(req.params.vid, req.session.userId);
  res.redirect(303, `${BASE}/viewers?msg=revoked`);
});

// ─── 초대 수락 (로그인 불필요) ─────────────────────────────────────
function inviteStandalone(title, inner) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
  <style>${css}</style></head><body style="background:linear-gradient(135deg,#0f172a,#1e3a5f);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="width:100%;max-width:440px">${inner}</div></body></html>`;
}

router.get('/invite/:token', async (req, res) => {
  const inv = await db.getInviteByToken(req.params.token);
  if (!inv) return res.send(inviteStandalone('초대', '<div class="card"><div class="card-body" style="text-align:center"><div style="font-size:36px">⚠️</div><h2 style="margin:8px 0">유효하지 않은 초대 링크</h2><p style="color:#6b7280">링크가 만료되었거나 잘못되었습니다. 담당자에게 재발송을 요청해주세요.</p></div></div>'));
  const existing = await db.getViewerUserByEmail(inv.email);
  res.send(inviteStandalone(inv.account_name + ' 입찰관리 초대', `
    <div class="card"><div class="card-body">
      <div style="text-align:center;margin-bottom:18px">
        <div style="font-size:32px">🎯</div>
        <h2 style="font-size:19px;font-weight:800;margin-top:6px">${escHtml(inv.account_name)} 입찰관리</h2>
        <p style="color:#6b7280;font-size:13px;margin-top:4px">${escHtml(inv.email)} 님을 초대했습니다.</p>
      </div>
      <form method="post" action="${BASE}/invite/${req.params.token}">
        ${req.query.err ? '<div class="alert alert-err">' + escHtml(req.query.err) + '</div>' : ''}
        <div style="margin-bottom:12px"><label>이름</label><input name="name" value="${existing ? escHtml(existing.name) : ''}" required></div>
        <div style="margin-bottom:16px"><label>비밀번호 ${existing ? '(기존 계정)' : '(새로 설정)'}</label><input type="password" name="password" required minlength="4"></div>
        <button class="btn btn-primary" style="width:100%;justify-content:center">${existing ? '로그인하고 입찰관리 열기' : '계정 만들고 입찰관리 열기'}</button>
      </form>
      <p style="font-size:12px;color:#9ca3af;text-align:center;margin-top:14px">이 계정은 <b>조회 + 조정 승인</b> 권한만 가집니다.</p>
    </div></div>`));
});

router.post('/invite/:token', async (req, res) => {
  const token = req.params.token;
  const inv = await db.getInviteByToken(token);
  const back = (err) => res.redirect(303, `${BASE}/invite/${token}?err=${encodeURIComponent(err)}`);
  if (!inv) return res.send(inviteStandalone('초대', '<div class="card"><div class="card-body" style="text-align:center"><h2>유효하지 않은 초대입니다.</h2></div></div>'));
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
    await bidDb.audit(inv.account_id, name, '광고주 초대 수락', { email: inv.email });
    req.session.userId = viewer.id;
    req.session.userName = viewer.name;
    req.session.isAdmin = false;
    req.session.approved = 1;
    req.session.role = 'viewer';
    req.session.bidAccountId = inv.account_id;
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
  // app_enabled='1' 설정된 광고주 + 소유자/연결 대행사 자격증명
  const r = await bidDb.pool.query(`
    SELECT a.*,
           COALESCE(ac.api_key, u.api_key) AS api_key,
           COALESCE(ac.secret_key, u.secret_key) AS secret_key,
           COALESCE(ac.manager_customer_id, u.manager_customer_id) AS manager_customer_id
    FROM ad_accounts a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN agency_credentials ac ON ac.id = a.agency_credential_id
    JOIN bid_settings s ON s.account_id = a.id AND s.key = 'app_enabled' AND s.value = '1'
  `);
  return r.rows.filter(a => a.api_key);
}

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
  const month = dateStr.slice(0, 7);
  const results = [];

  try {
    const accounts = await getCronAccounts();
    for (const account of accounts) {
      const creds = { api_key: account.api_key, secret_key: account.secret_key, manager_customer_id: account.manager_customer_id };

      // 주간: 월요일 06시 (KST)
      if (dow === 1 && hour === 6) {
        const weekStart = logic.last4Weeks()[0].start;
        if (await bidDb.tryClaimCronRun(`weekly:${account.id}:${weekStart}`)) {
          try {
            const r = await engine.runWeekly(account, creds, { actor: 'cron' });
            results.push({ account: account.name, job: 'weekly', ...r });
          } catch (e) { results.push({ account: account.name, job: 'weekly', error: e.message }); }
        }
      }
      // 일간 모니터: 매일 07시 (KST) — 전일 데이터
      if (hour === 7) {
        const yesterday = logic.fmtDate(new Date(kst.getTime() - 24 * 60 * 60 * 1000));
        if (await bidDb.tryClaimCronRun(`daily:${account.id}:${yesterday}`)) {
          try {
            const r = await engine.runDailyMonitor(account, creds, yesterday);
            results.push({ account: account.name, job: 'daily', ...r });
          } catch (e) { results.push({ account: account.name, job: 'daily', error: e.message }); }
        }
      }
      // 월간 리포트: 매월 1일 06시 (KST) — 전월 기준
      if (day === 1 && hour === 6) {
        const prev = new Date(kst); prev.setUTCDate(0);
        const prevMonth = logic.fmtDate(prev).slice(0, 7);
        if (await bidDb.tryClaimCronRun(`monthly:${account.id}:${prevMonth}`)) {
          try {
            const r = await engine.runMonthlyReport(account, prevMonth);
            results.push({ account: account.name, job: 'monthly', month: prevMonth, targets: r.reviewTargets.length });
          } catch (e) { results.push({ account: account.name, job: 'monthly', error: e.message }); }
        }
      }
    }
    res.json({ ok: true, kst: `${dateStr} ${hour}시`, accounts: accounts.length, results });
  } catch (e) {
    console.error('❌ 입찰관리 cron tick:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = { router };
