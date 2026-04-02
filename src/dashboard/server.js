const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { config } = require('../../config');
const db = require('../db/database');
const { createApiClient } = require('../api/naverApi');
const { generateAndSend } = require('../report/generator');

const router = express.Router();

// ─── 세션 미들웨어 (Supabase PostgreSQL에 세션 저장) ───────────────
router.use(session({
  store: new pgSession({
    pool: db.pool,
    tableName: 'user_sessions',
    createTableIfMissing: true,
  }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 },
}));

router.use(express.json());
router.use(express.urlencoded({ extended: true }));

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/smart-sa/login');
  // 승인 대기 상태면 대기 페이지로
  if (req.session.approved === 0 && req.path !== '/pending' && req.path !== '/logout') {
    return res.redirect('/smart-sa/pending');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect('/smart-sa');
  next();
}

// API 자격증명 등록 여부 체크 미들웨어
async function requireApi(req, res, next) {
  const creds = await db.getApiCredentials(req.session.userId);
  if (!creds) return res.redirect('/smart-sa/api-settings?msg=need');
  req.apiCreds = creds;
  next();
}

// ─── 공통 HTML 레이아웃 ────────────────────────────────────────────
const css = `
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Apple SD Gothic Neo','Malgun Gothic',sans-serif;background:#f0f2f5;color:#1e293b;font-size:14px}
  a{text-decoration:none;color:inherit}
  input,select,textarea{padding:9px 12px;border:1px solid #e2e8f0;border-radius:8px;font-size:14px;width:100%;background:#fff;outline:none;transition:border .15s}
  input:focus,select:focus,textarea:focus{border-color:#03c75a;box-shadow:0 0 0 3px rgba(3,199,90,.1)}
  label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:5px}
  .btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:8px;border:none;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
  .btn-primary{background:#03c75a;color:#fff} .btn-primary:hover{background:#02b350}
  .btn-danger{background:#ef4444;color:#fff} .btn-danger:hover{background:#dc2626}
  .btn-outline{background:#fff;color:#374151;border:1px solid #e2e8f0} .btn-outline:hover{background:#f8fafc}
  .btn-sm{padding:6px 12px;font-size:12px}
  .btn:disabled{opacity:.5;cursor:not-allowed}
  .card{background:#fff;border-radius:12px;border:1px solid #e2e8f0;overflow:hidden}
  .card-header{padding:16px 20px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between}
  .card-title{font-size:15px;font-weight:600}
  .card-body{padding:20px}
  table{width:100%;border-collapse:collapse}
  th{padding:10px 14px;text-align:left;font-size:11px;color:#64748b;font-weight:600;background:#f8fafc;border-bottom:1px solid #f1f5f9;text-transform:uppercase;letter-spacing:.04em}
  td{padding:11px 14px;border-bottom:1px solid #f8fafc;font-size:13px}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#fafbfc}
  .badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
  .badge-green{background:#dcfce7;color:#16a34a} .badge-gray{background:#f1f5f9;color:#64748b}
  .badge-blue{background:#dbeafe;color:#2563eb} .badge-red{background:#fee2e2;color:#dc2626}
  .toggle{width:38px;height:22px;border-radius:11px;position:relative;cursor:default;flex-shrink:0;transition:background .2s}
  .toggle-on{background:#03c75a} .toggle-off{background:#cbd5e1}
  .toggle-dot{position:absolute;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:left .15s}
  .toggle-on .toggle-dot{left:19px} .toggle-off .toggle-dot{left:3px}
  .form-group{margin-bottom:16px}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .alert{padding:12px 16px;border-radius:8px;margin-bottom:16px;font-size:13px}
  .alert-err{background:#fee2e2;color:#dc2626;border:1px solid #fca5a5}
  .alert-ok{background:#dcfce7;color:#16a34a;border:1px solid #86efac}
  .alert-info{background:#dbeafe;color:#2563eb;border:1px solid #93c5fd}
  .sidebar{width:240px;min-height:100vh;background:#1e293b;color:#fff;position:fixed;top:0;left:0;display:flex;flex-direction:column}
  .sidebar-header{padding:20px 20px 16px;border-bottom:1px solid rgba(255,255,255,.1)}
  .sidebar-logo{font-size:16px;font-weight:700;color:#03c75a}
  .sidebar-sub{font-size:11px;color:rgba(255,255,255,.4);margin-top:3px}
  .sidebar-section{padding:12px 12px 4px;font-size:10px;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:.08em}
  .sidebar-link{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13px;color:rgba(255,255,255,.7);cursor:pointer;transition:all .15s;margin:1px 8px;border:none;background:transparent;width:calc(100%-16px)}
  .sidebar-link:hover,.sidebar-link.active{background:rgba(255,255,255,.1);color:#fff}
  .sidebar-footer{margin-top:auto;padding:16px;border-top:1px solid rgba(255,255,255,.1)}
  .sidebar-user{font-size:13px;color:rgba(255,255,255,.7)}
  .main{margin-left:240px;min-height:100vh}
  .topbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:0 24px;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
  .topbar-title{font-size:16px;font-weight:700}
  .content{padding:24px}
  .kpi-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:20px}
  @media(max-width:1100px){.kpi-grid{grid-template-columns:repeat(3,1fr)}}
  .kpi-card{background:#fff;border-radius:12px;padding:18px 20px;border:1px solid #e2e8f0}
  .kpi-label{font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
  .kpi-value{font-size:24px;font-weight:700;color:#111827}
  .period-tabs{display:flex;background:#fff;border-radius:8px;padding:3px;border:1px solid #e2e8f0;gap:2px}
  .period-btn{padding:6px 16px;border-radius:6px;border:none;background:transparent;font-size:13px;font-weight:500;cursor:pointer;color:#64748b}
  .period-btn.active{background:#03c75a;color:#fff}
  .spinner{width:18px;height:18px;border:2px solid #e2e8f0;border-top-color:#03c75a;border-radius:50%;animation:spin .6s linear infinite;display:inline-block}
  @keyframes spin{to{transform:rotate(360deg)}}
  .empty{text-align:center;padding:40px;color:#94a3b8}
  .toast-wrap{position:fixed;bottom:24px;right:24px;display:flex;flex-direction:column;gap:8px;z-index:999}
  .toast{padding:12px 20px;border-radius:10px;font-size:13px;font-weight:500;box-shadow:0 4px 16px rgba(0,0,0,.15);animation:fadeIn .2s ease}
  .toast-ok{background:#1e293b;color:#fff} .toast-err{background:#dc2626;color:#fff}
  @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
`;

function layout(title, body, user = null) {
  return `<!DOCTYPE html><html lang="ko"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} - 네이버 SA 솔루션</title>
<style>${css}</style></head><body>${body}
<div class="toast-wrap" id="toast-wrap"></div>
<script>
function toast(msg, isErr=false){
  const w=document.getElementById('toast-wrap');
  const el=document.createElement('div');
  el.className='toast '+(isErr?'toast-err':'toast-ok');
  el.textContent=msg; w.appendChild(el);
  setTimeout(()=>el.remove(),3500);
}
</script></body></html>`;
}

function appLayout(title, content, user, activeMenu) {
  const menuItems = [
    { id: 'dashboard', icon: '📊', label: '성과 대시보드', href: '/smart-sa' },
    { id: 'rankings',  icon: '📍', label: '키워드 순위',   href: '/smart-sa/rankings' },
    { id: 'reports',   icon: '📧', label: '리포트',        href: '/smart-sa/reports' },
    { id: 'accounts',  icon: '🏢', label: '광고주 관리',   href: '/smart-sa/accounts' },
    { id: 'api',       icon: '🔑', label: 'API 설정',      href: '/smart-sa/api-settings' },
  ];
  if (user?.is_admin) {
    menuItems.push({ id: 'admin', icon: '👥', label: '직원 관리', href: '/smart-sa/admin/users' });
  }

  const sidebar = `
  <div class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-logo">네이버 SA 솔루션</div>
      <div class="sidebar-sub">광고대행사 관리 시스템</div>
    </div>
    <div style="padding:8px">
      ${menuItems.map(m => `
        <a href="${m.href}" class="sidebar-link ${activeMenu === m.id ? 'active' : ''}">
          <span>${m.icon}</span><span>${m.label}</span>
        </a>
      `).join('')}
    </div>
    <div class="sidebar-footer">
      <div class="sidebar-user">👤 ${user?.name || user?.username}</div>
      <a href="/smart-sa/logout" class="sidebar-link" style="margin:8px 0 0;padding:6px 12px">↩ 로그아웃</a>
    </div>
  </div>`;

  return layout(title, `
    ${sidebar}
    <div class="main">
      <div class="topbar">
        <div class="topbar-title">${title}</div>
      </div>
      <div class="content">${content}</div>
    </div>
  `, user);
}

// ─── 로그인 ─────────────────────────────────────────────────────────
router.get('/login', async (req, res) => {
  if (req.session.userId) return res.redirect('/smart-sa');
  const userCount = await db.countUsers();
  const isFirst = userCount === 0;
  const err = req.query.err || '';

  res.send(layout('로그인', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f0f9ff,#f0fdf4)">
      <div style="width:100%;max-width:400px;padding:16px">
        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:40px;margin-bottom:8px">📊</div>
          <h1 style="font-size:22px;font-weight:700;color:#111827">네이버 SA 솔루션</h1>
          <p style="color:#64748b;margin-top:6px;font-size:13px">광고대행사 통합 관리 시스템</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${err === 'invalid' ? '<div class="alert alert-err">아이디 또는 비밀번호가 올바르지 않습니다.</div>' : ''}
            ${isFirst ? '<div class="alert alert-ok">최초 실행입니다. 관리자 계정을 생성해주세요.</div>' : ''}
            <form method="POST" action="${isFirst ? '/smart-sa/register' : '/smart-sa/login'}">
              <div class="form-group">
                <label>${isFirst ? '아이디 (영문)' : '아이디'}</label>
                <input name="username" required placeholder="username" autocomplete="username">
              </div>
              ${isFirst ? `<div class="form-group"><label>이름</label><input name="name" required placeholder="홍길동"></div>` : ''}
              <div class="form-group">
                <label>비밀번호</label>
                <input type="password" name="password" required placeholder="••••••••" autocomplete="current-password">
              </div>
              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px">
                ${isFirst ? '계정 생성 후 로그인' : '로그인'}
              </button>
            </form>
            ${!isFirst ? `
            <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #f1f5f9">
              <span style="font-size:13px;color:#64748b">계정이 없으신가요?</span>
              <a href="/smart-sa/signup" style="font-size:13px;color:#03c75a;font-weight:600;margin-left:6px">회원가입</a>
            </div>` : ''}
          </div>
        </div>
      </div>
    </div>
  `));
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await db.authenticateUser(username, password);
  if (!user) return res.redirect('/smart-sa/login?err=invalid');
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = !!user.is_admin;
  req.session.approved = user.approved;
  res.redirect('/smart-sa');
});

router.post('/register', async (req, res) => {
  const { username, password, name } = req.body;
  try {
    const count = await db.countUsers();
    if (count > 0) return res.redirect('/smart-sa/login');
    // 최초 사용자는 관리자 + 승인 완료
    const id = await db.createUser(username, password, name || username, { isAdmin: true, approved: true });
    req.session.userId = id;
    req.session.userName = name || username;
    req.session.isAdmin = true;
    req.session.approved = 1;
    res.redirect('/smart-sa');
  } catch (e) {
    res.redirect('/smart-sa/login?err=taken');
  }
});

router.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/smart-sa');
  const err = req.query.err || '';
  res.send(layout('회원가입', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f0f9ff,#f0fdf4)">
      <div style="width:100%;max-width:400px;padding:16px">
        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:40px;margin-bottom:8px">📊</div>
          <h1 style="font-size:22px;font-weight:700;color:#111827">네이버 SA 솔루션</h1>
          <p style="color:#64748b;margin-top:6px;font-size:13px">직원 계정 생성</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${err === 'taken' ? '<div class="alert alert-err">이미 사용 중인 아이디입니다.</div>' : ''}
            <form method="POST" action="/smart-sa/signup">
              <div class="form-group">
                <label>아이디 (영문)</label>
                <input name="username" required placeholder="username" autocomplete="username">
              </div>
              <div class="form-group">
                <label>이름</label>
                <input name="name" required placeholder="홍길동">
              </div>
              <div class="form-group">
                <label>비밀번호</label>
                <input type="password" name="password" required placeholder="••••••••" autocomplete="new-password">
              </div>
              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px">계정 생성</button>
            </form>
            <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #f1f5f9">
              <a href="/smart-sa/login" style="font-size:13px;color:#03c75a;font-weight:600">← 로그인으로 돌아가기</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `));
});

router.post('/signup', async (req, res) => {
  const { username, password, name } = req.body;
  try {
    // 승인 대기(approved=0) 상태로 생성
    const id = await db.createUser(username, password, name || username, { isAdmin: false, approved: false });
    req.session.userId = id;
    req.session.userName = name || username;
    req.session.isAdmin = false;
    req.session.approved = 0;
    res.redirect('/smart-sa/pending');
  } catch (e) {
    res.redirect('/smart-sa/signup?err=taken');
  }
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/smart-sa/login'));
});

// ─── 승인 대기 페이지 ──────────────────────────────────────────────
router.get('/pending', (req, res) => {
  if (!req.session.userId) return res.redirect('/smart-sa/login');
  res.send(layout('승인 대기', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f0f9ff,#f0fdf4)">
      <div style="width:100%;max-width:420px;padding:16px;text-align:center">
        <div style="font-size:48px;margin-bottom:16px">⏳</div>
        <h1 style="font-size:22px;font-weight:700;color:#111827;margin-bottom:8px">승인 대기 중</h1>
        <p style="color:#64748b;font-size:14px;line-height:1.7;margin-bottom:24px">
          회원가입이 완료되었습니다.<br>
          관리자가 승인하면 솔루션을 사용할 수 있습니다.<br>
          승인 후 다시 로그인해주세요.
        </p>
        <a href="/smart-sa/logout" class="btn btn-outline" style="justify-content:center">로그아웃</a>
      </div>
    </div>
  `));
});

// ─── 관리자: 직원 관리 ─────────────────────────────────────────────
router.get('/admin/users', requireLogin, requireAdmin, async (req, res) => {
  const user = await getUser(req);
  const allUsers = await db.getAllUsers();
  const msg = req.query.msg || '';

  const content = `
    ${msg === 'approved' ? '<div class="alert alert-ok">승인되었습니다.</div>' : ''}
    ${msg === 'rejected' ? '<div class="alert alert-err">거부되었습니다.</div>' : ''}

    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">⏳ 승인 대기</span>
        <span style="font-size:12px;color:#94a3b8">${allUsers.filter(u => !u.approved).length}명</span>
      </div>
      ${allUsers.filter(u => !u.approved).length === 0
        ? '<div class="card-body"><div class="empty" style="padding:20px">승인 대기 중인 직원이 없습니다.</div></div>'
        : `<table>
            <thead><tr><th>이름</th><th>아이디</th><th>가입일</th><th style="text-align:center">관리</th></tr></thead>
            <tbody>
              ${allUsers.filter(u => !u.approved).map(u => `
                <tr>
                  <td><strong>${u.name}</strong></td>
                  <td style="color:#64748b">${u.username}</td>
                  <td style="font-size:12px;color:#94a3b8">${new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
                  <td style="text-align:center">
                    <form method="POST" action="/smart-sa/admin/users/${u.id}/approve" style="display:inline">
                      <button class="btn btn-primary btn-sm">승인</button>
                    </form>
                    <form method="POST" action="/smart-sa/admin/users/${u.id}/reject" style="display:inline;margin-left:4px">
                      <button class="btn btn-danger btn-sm">거부</button>
                    </form>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
      }
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">👥 전체 직원</span>
        <span style="font-size:12px;color:#94a3b8">${allUsers.filter(u => u.approved).length}명</span>
      </div>
      <table>
        <thead><tr><th>이름</th><th>아이디</th><th>권한</th><th>가입일</th></tr></thead>
        <tbody>
          ${allUsers.filter(u => u.approved).map(u => `
            <tr>
              <td><strong>${u.name}</strong></td>
              <td style="color:#64748b">${u.username}</td>
              <td>${u.is_admin ? '<span class="badge badge-blue">관리자</span>' : '<span class="badge badge-gray">직원</span>'}</td>
              <td style="font-size:12px;color:#94a3b8">${new Date(u.created_at).toLocaleDateString('ko-KR')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  res.send(appLayout('직원 관리', content, user, 'admin'));
});

router.post('/admin/users/:id/approve', requireLogin, requireAdmin, async (req, res) => {
  await db.approveUser(req.params.id);
  res.redirect('/smart-sa/admin/users?msg=approved');
});

router.post('/admin/users/:id/reject', requireLogin, requireAdmin, async (req, res) => {
  await db.rejectUser(req.params.id);
  res.redirect('/smart-sa/admin/users?msg=rejected');
});

// ─── 헬퍼 ──────────────────────────────────────────────────────────
async function getUser(req) {
  return db.getUserById(req.session.userId);
}

// 사용자의 API 자격증명으로 특정 광고주(customerId)용 API 클라이언트 생성
function makeClient(creds, customerId) {
  return createApiClient({
    apiKey: creds.api_key,
    secretKey: creds.secret_key,
    customerId,
  });
}

// ─── API 설정 페이지 ───────────────────────────────────────────────
router.get('/api-settings', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const creds = await db.getApiCredentials(user.id);
  const msg = req.query.msg || '';

  const content = `
    ${msg === 'need' ? '<div class="alert alert-info">솔루션을 사용하려면 먼저 네이버 검색광고 API 계정을 등록해주세요.</div>' : ''}
    ${msg === 'saved' ? '<div class="alert alert-ok">API 계정이 저장되었습니다.</div>' : ''}
    ${msg === 'invalid' ? '<div class="alert alert-err">API 인증에 실패했습니다. 입력 정보를 확인해주세요.</div>' : ''}

    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">🔑 네이버 검색광고 API 계정</span>
        ${creds ? '<span class="badge badge-green">등록됨</span>' : '<span class="badge badge-gray">미등록</span>'}
      </div>
      <div class="card-body">
        <p style="color:#64748b;font-size:13px;margin-bottom:16px">
          네이버 검색광고 시스템의 API 키를 등록하면, 해당 계정에 연결된 모든 광고주에 접근할 수 있습니다.<br>
          <a href="https://searchad.naver.com" target="_blank" style="color:#03c75a">검색광고 시스템</a> → 도구 → API 사용 관리에서 발급받으세요.
        </p>
        <form method="POST" action="/smart-sa/api-settings">
          <div class="form-group">
            <label>API Key (액세스라이선스) *</label>
            <input name="api_key" required value="${creds?.api_key || ''}" placeholder="01000000-0000-0000-0000-000000000000">
          </div>
          <div class="form-group">
            <label>Secret Key (비밀키) *</label>
            <input name="secret_key" required value="${creds?.secret_key || ''}" placeholder="AQAAAABk...">
          </div>
          <div class="form-group">
            <label>매니저 Customer ID (내 계정 ID) *</label>
            <input name="manager_customer_id" required value="${creds?.manager_customer_id || ''}" placeholder="1234567">
          </div>
          <button class="btn btn-primary">저장</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">📖 설정 안내</span></div>
      <div class="card-body" style="font-size:13px;color:#64748b;line-height:1.8">
        <strong>1단계:</strong> 위에 API 계정 정보를 입력하고 저장합니다.<br>
        <strong>2단계:</strong> <a href="/smart-sa/accounts" style="color:#03c75a">광고주 관리</a> 페이지에서 광고주 목록을 불러옵니다.<br>
        <strong>3단계:</strong> 솔루션을 적용할 광고주를 선택합니다.<br>
        <strong>4단계:</strong> 각 광고주별로 리포트, 자동입찰 등 활용 기능을 설정합니다.
      </div>
    </div>
  `;

  res.send(appLayout('API 설정', content, user, 'api'));
});

router.post('/api-settings', requireLogin, async (req, res) => {
  const { api_key, secret_key, manager_customer_id } = req.body;

  // API 연결 테스트
  try {
    const testClient = createApiClient({ apiKey: api_key, secretKey: secret_key, customerId: manager_customer_id });
    await testClient.getCustomerLinks();
  } catch (e) {
    return res.redirect('/smart-sa/api-settings?msg=invalid');
  }

  await db.updateApiCredentials(req.session.userId, api_key, secret_key, manager_customer_id);
  res.redirect('/smart-sa/api-settings?msg=saved');
});

// ─── 광고주 관리 (불러오기 + 선택 + 기능 설정) ──────────────────────
router.get('/accounts', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);
  const msg = req.query.msg || '';

  const content = `
    ${msg === 'saved' ? '<div class="alert alert-ok">저장되었습니다.</div>' : ''}
    ${msg === 'deleted' ? '<div class="alert alert-err">삭제되었습니다.</div>' : ''}
    ${msg === 'added' ? '<div class="alert alert-ok">광고주가 추가되었습니다.</div>' : ''}

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px">
      <p style="color:#64748b;font-size:13px">API 계정에 연결된 광고주를 불러와 솔루션 적용 대상을 선택합니다.</p>
      <button class="btn btn-primary" onclick="loadCustomers()" id="load-btn">📥 광고주 불러오기</button>
    </div>

    <!-- 광고주 불러오기 결과 영역 -->
    <div id="customer-list-wrap" style="display:none;margin-bottom:20px">
      <div class="card">
        <div class="card-header">
          <span class="card-title">📋 API 연결 광고주 목록</span>
          <span id="customer-count" style="font-size:12px;color:#94a3b8"></span>
        </div>
        <div id="customer-list-body"></div>
      </div>
    </div>

    <!-- 선택된(활성) 광고주 목록 -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">🏢 솔루션 적용 광고주</span>
        <span style="font-size:12px;color:#94a3b8">${accounts.length}개</span>
      </div>
      ${accounts.length === 0
        ? '<div class="empty">위의 "광고주 불러오기" 버튼을 눌러<br>솔루션을 적용할 광고주를 선택해주세요.</div>'
        : `<table>
            <thead><tr><th>광고주명</th><th>Customer ID</th><th>활용 기능</th><th>리포트 이메일</th><th style="text-align:center">관리</th></tr></thead>
            <tbody>
              ${accounts.map(a => `
                <tr>
                  <td><strong>${a.name}</strong></td>
                  <td style="font-family:monospace;font-size:12px;color:#64748b">${a.customer_id}</td>
                  <td>
                    ${a.feat_daily_report ? '<span class="badge badge-green" style="margin:2px">일간</span>' : ''}
                    ${a.feat_weekly_report ? '<span class="badge badge-green" style="margin:2px">주간</span>' : ''}
                    ${a.feat_monthly_report ? '<span class="badge badge-green" style="margin:2px">월간</span>' : ''}
                    ${a.feat_keyword_monitor ? '<span class="badge badge-blue" style="margin:2px">순위모니터</span>' : ''}
                    ${a.feat_auto_bidding ? '<span class="badge badge-blue" style="margin:2px">자동입찰</span>' : ''}
                    ${!a.feat_daily_report && !a.feat_weekly_report && !a.feat_monthly_report && !a.feat_keyword_monitor && !a.feat_auto_bidding ? '<span class="badge badge-gray">미설정</span>' : ''}
                  </td>
                  <td style="font-size:12px;color:#64748b">${a.report_emails || '—'}</td>
                  <td style="text-align:center">
                    <a href="/smart-sa/accounts/${a.id}/edit" class="btn btn-outline btn-sm">설정</a>
                    <button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteAccount(${a.id},'${a.name}')">제거</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
      }
    </div>

    <script>
    async function loadCustomers() {
      const btn = document.getElementById('load-btn');
      btn.disabled = true; btn.textContent = '불러오는 중...';
      try {
        const res = await fetch('/smart-sa/api/customer-links');
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        const customers = json.customers;
        const wrap = document.getElementById('customer-list-wrap');
        wrap.style.display = 'block';
        document.getElementById('customer-count').textContent = customers.length + '개 광고주';

        if (!customers.length) {
          document.getElementById('customer-list-body').innerHTML = '<div class="empty">연결된 광고주가 없습니다.</div>';
          return;
        }

        const alreadyAdded = ${JSON.stringify(accounts.map(a => a.customer_id))};
        document.getElementById('customer-list-body').innerHTML = '<table><thead><tr>'
          +'<th>광고주명</th><th>Customer ID</th><th style="text-align:center">상태</th>'
          +'</tr></thead><tbody>'
          + customers.map(c => {
            const added = alreadyAdded.includes(String(c.customerId));
            return '<tr>'
              +'<td><strong>'+(c.customerName || c.loginId || '-')+'</strong></td>'
              +'<td style="font-family:monospace;font-size:12px;color:#64748b">'+c.customerId+'</td>'
              +'<td style="text-align:center">'
              +(added
                ? '<span class="badge badge-green">추가됨</span>'
                : '<button class="btn btn-primary btn-sm" onclick="addCustomer(\\''+c.customerId+'\\',\\''+( c.customerName || c.loginId || c.customerId )+'\\',this)">+ 선택</button>')
              +'</td></tr>';
          }).join('')
          +'</tbody></table>';
      } catch(e) {
        toast('광고주 불러오기 실패: '+e.message, true);
      } finally {
        btn.disabled = false; btn.textContent = '📥 광고주 불러오기';
      }
    }

    async function addCustomer(customerId, name, btnEl) {
      btnEl.disabled = true; btnEl.textContent = '추가 중...';
      try {
        const res = await fetch('/smart-sa/api/add-customer', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ customerId, name })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        btnEl.outerHTML = '<span class="badge badge-green">추가됨</span>';
        toast(name + ' 광고주가 추가되었습니다.');
        setTimeout(() => location.reload(), 1000);
      } catch(e) {
        toast('추가 실패: '+e.message, true);
        btnEl.disabled = false; btnEl.textContent = '+ 선택';
      }
    }

    async function deleteAccount(id, name) {
      if (!confirm(name+' 광고주를 솔루션에서 제거할까요?')) return;
      const res = await fetch('/smart-sa/accounts/'+id, {method:'DELETE'});
      const json = await res.json();
      if (json.ok) location.href='/smart-sa/accounts?msg=deleted';
      else toast('삭제 실패: '+json.error, true);
    }
    </script>
  `;
  res.send(appLayout('광고주 관리', content, user, 'accounts'));
});

// API: 연결된 광고주 목록 불러오기
router.get('/api/customer-links', requireLogin, async (req, res) => {
  try {
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    const client = makeClient(creds, creds.manager_customer_id);
    const customers = await client.getCustomerLinks();
    res.json({ ok: true, customers: Array.isArray(customers) ? customers : [] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 광고주 선택(추가)
router.post('/api/add-customer', requireLogin, async (req, res) => {
  try {
    const { customerId, name } = req.body;
    if (!customerId) return res.status(400).json({ ok: false, error: 'Customer ID 필요' });
    const id = await db.addSelectedAccount(req.session.userId, String(customerId), name || String(customerId));
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 광고주 기능 설정 폼
function accountSettingsForm(account = {}) {
  const v = (k, def = '') => account[k] ?? def;
  const chk = k => account[k] ? 'checked' : '';
  return `
    <form method="POST">
      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">📌 광고주 정보</span></div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label>광고주명</label>
              <input name="name" required value="${v('name')}" placeholder="광고주명">
            </div>
            <div class="form-group">
              <label>Customer ID</label>
              <input value="${v('customer_id')}" disabled style="background:#f8fafc;color:#64748b">
            </div>
          </div>
          <div class="form-group">
            <label>리포트 수신 이메일 (쉼표로 구분)</label>
            <input name="report_emails" value="${v('report_emails')}" placeholder="a@a.com,b@b.com">
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">이메일 발송 설정 (SMTP)</span></div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group"><label>SMTP 서버</label><input name="email_host" value="${v('email_host','smtp.gmail.com')}" placeholder="smtp.gmail.com"></div>
            <div class="form-group"><label>포트</label><input name="email_port" type="number" value="${v('email_port',587)}" placeholder="587"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>발송 이메일</label><input name="email_user" value="${v('email_user')}" placeholder="sender@gmail.com"></div>
            <div class="form-group"><label>앱 비밀번호</label><input type="password" name="email_pass" value="${v('email_pass')}" placeholder="16자리 앱 비밀번호"></div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:16px">
        <div class="card-header"><span class="card-title">활용 기능 ON/OFF</span></div>
        <div class="card-body" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">
          ${[
            ['feat_daily_report','일간 리포트 자동발송','매일 08:00'],
            ['feat_weekly_report','주간 리포트 자동발송','월요일 09:00'],
            ['feat_monthly_report','월간 리포트 자동발송','매월 1일 09:00'],
            ['feat_keyword_monitor','키워드 순위 모니터',''],
            ['feat_auto_bidding','자동입찰','주의: 빈번한 API 호출'],
          ].map(([k,label,desc]) => `
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:10px;background:#f8fafc;border-radius:8px;border:1px solid #e2e8f0">
              <input type="checkbox" name="${k}" ${chk(k)} style="width:16px;height:16px;flex-shrink:0">
              <div>
                <div style="font-size:13px;font-weight:500">${label}</div>
                ${desc ? `<div style="font-size:11px;color:#94a3b8">${desc}</div>` : ''}
              </div>
            </label>
          `).join('')}
        </div>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div class="card-header"><span class="card-title">자동입찰 설정</span></div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group"><label>목표 순위</label><input type="number" name="auto_bid_target_rank" value="${v('auto_bid_target_rank',3)}" min="1" max="15"></div>
            <div class="form-group"><label>실행 간격 (분)</label><input type="number" name="auto_bid_interval" value="${v('auto_bid_interval',5)}" min="1"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>최대 입찰가 (원)</label><input type="number" name="auto_bid_max_bid" value="${v('auto_bid_max_bid',5000)}"></div>
            <div class="form-group"><label>최소 입찰가 (원)</label><input type="number" name="auto_bid_min_bid" value="${v('auto_bid_min_bid',100)}"></div>
          </div>
        </div>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn btn-primary">저장</button>
        <a href="/smart-sa/accounts" class="btn btn-outline">취소</a>
      </div>
    </form>
  `;
}

router.get('/accounts/:id/edit', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const account = await db.getAccountById(req.params.id, user.id);
  if (!account) return res.redirect('/smart-sa/accounts');
  ['feat_daily_report','feat_weekly_report','feat_monthly_report','feat_keyword_monitor','feat_auto_bidding']
    .forEach(k => { account[k] = !!account[k]; });
  res.send(appLayout(account.name + ' 설정', accountSettingsForm(account), user, 'accounts'));
});

router.post('/accounts/:id/edit', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const data = { ...req.body };
  ['feat_daily_report','feat_weekly_report','feat_monthly_report','feat_keyword_monitor','feat_auto_bidding']
    .forEach(k => { data[k] = k in req.body; });
  await db.updateAccount(req.params.id, user.id, data);
  res.redirect('/smart-sa/accounts?msg=saved');
});

router.delete('/accounts/:id', requireLogin, async (req, res) => {
  const user = await getUser(req);
  await db.deleteAccount(req.params.id, user.id);
  res.json({ ok: true });
});

// ─── 성과 대시보드 ──────────────────────────────────────────────────
router.get('/', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);

  const content = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <div class="period-tabs">
        <button class="period-btn active" data-period="yesterday">어제</button>
        <button class="period-btn" data-period="7days">최근 7일</button>
        <button class="period-btn" data-period="30days">최근 30일</button>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <label style="margin:0;font-size:13px;color:#64748b">광고주:</label>
        <select id="account-select" style="width:200px">
          ${accounts.length === 0
            ? '<option value="">— 광고주 없음 —</option>'
            : accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('')}
        </select>
        <button class="btn btn-outline btn-sm" onclick="loadStats()">↻ 조회</button>
      </div>
    </div>

    <div class="kpi-grid" id="kpi-grid">
      ${['👁 노출수','🖱 클릭수','📊 CTR','💰 전환매출','🎯 평균순위'].map(l => `
        <div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value" style="color:#e2e8f0">—</div></div>
      `).join('')}
    </div>

    <div class="card">
      <div class="card-header">
        <span class="card-title">🔑 키워드별 성과</span>
        <span id="kw-count" style="font-size:12px;color:#94a3b8"></span>
      </div>
      <div id="kw-table-wrap">
        ${accounts.length === 0
          ? `<div class="empty">광고주를 먼저 선택해주세요.<br><a href="/smart-sa/accounts" style="color:#03c75a;margin-top:8px;display:inline-block">광고주 관리</a></div>`
          : '<div class="empty"><span class="spinner"></span> 광고주를 선택하고 조회를 눌러주세요.</div>'}
      </div>
    </div>

    <script>
    let currentPeriod = 'yesterday';
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPeriod = btn.dataset.period;
        loadStats();
      });
    });

    async function loadStats() {
      const accountId = document.getElementById('account-select').value;
      if (!accountId) return toast('광고주를 선택해주세요.', true);

      document.getElementById('kpi-grid').innerHTML = ${JSON.stringify(
        ['👁 노출수','🖱 클릭수','📊 CTR','💰 전환매출','🎯 평균순위'].map(l =>
          `<div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value"><span class="spinner"></span></div></div>`
        ).join('')
      )};
      document.getElementById('kw-table-wrap').innerHTML = '<div class="empty"><span class="spinner"></span> 로딩 중...</div>';

      try {
        const res = await fetch('/smart-sa/api/stats?period='+currentPeriod+'&accountId='+accountId);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        renderKpi(json.stats);
        renderKwTable(json.keywordStats || []);
      } catch(e) {
        toast('조회 실패: '+e.message, true);
        document.getElementById('kw-table-wrap').innerHTML = '<div class="empty">'+e.message+'</div>';
      }
    }

    function renderKpi(s) {
      const cards = [
        {l:'👁 노출수', v:num(s?.impCnt)},
        {l:'🖱 클릭수', v:num(s?.clkCnt)},
        {l:'📊 CTR',    v:pct(s?.ctr)},
        {l:'💰 전환매출',v:won(s?.salesAmt)},
        {l:'🎯 평균순위',v:rnk(s?.avgRnk)},
      ];
      document.getElementById('kpi-grid').innerHTML = cards.map(c =>
        '<div class="kpi-card"><div class="kpi-label">'+c.l+'</div><div class="kpi-value">'+c.v+'</div></div>'
      ).join('');
    }

    function renderKwTable(kwStats) {
      const sorted = [...kwStats].sort((a,b)=>(b.clkCnt||0)-(a.clkCnt||0));
      document.getElementById('kw-count').textContent = sorted.length+'개';
      if (!sorted.length) {
        document.getElementById('kw-table-wrap').innerHTML = '<div class="empty">키워드 데이터가 없습니다.</div>';
        return;
      }
      document.getElementById('kw-table-wrap').innerHTML = '<table><thead><tr>'
        +'<th>#</th><th>키워드</th><th style="text-align:right">노출</th><th style="text-align:right">클릭</th>'
        +'<th style="text-align:right">CTR</th><th style="text-align:right">전환매출</th><th style="text-align:right">순위</th>'
        +'</tr></thead><tbody>'
        +sorted.map((kw,i)=>'<tr>'
          +'<td style="color:#94a3b8;text-align:center">'+(i+1)+'</td>'
          +'<td><strong>'+(kw.keyword||kw.keywordId||'-')+'</strong></td>'
          +'<td style="text-align:right">'+num(kw.impCnt)+'</td>'
          +'<td style="text-align:right;color:#2563eb;font-weight:600">'+num(kw.clkCnt)+'</td>'
          +'<td style="text-align:right">'+pct(kw.ctr)+'</td>'
          +'<td style="text-align:right;color:#16a34a">'+won(kw.salesAmt)+'</td>'
          +'<td style="text-align:right">'+rnk(kw.avgRnk)+'</td>'
          +'</tr>').join('')
        +'</tbody></table>';
    }

    function num(v){return Number(v||0).toLocaleString('ko-KR')}
    function pct(v){return Number(v||0).toFixed(2)+'%'}
    function won(v){return '₩'+Number(v||0).toLocaleString('ko-KR')}
    function rnk(v){return v?Number(v).toFixed(1)+'위':'-'}
    </script>
  `;

  res.send(appLayout('성과 대시보드', content, user, 'dashboard'));
});

// ─── API: 통계 ──────────────────────────────────────────────────────
router.get('/api/stats', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    if (!accountId) return res.status(400).json({ ok: false, error: '광고주 ID 필요' });

    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주를 찾을 수 없습니다' });

    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const timeMap = { yesterday: 'yesterday', '7days': 'last7days', '30days': 'last30days' };
    const timeRange = timeMap[period] || 'yesterday';

    const [stats, keywordStats] = await Promise.all([
      client.getStats({ timeRange }).catch(() => null),
      client.getKeywordStats({ timeRange }).catch(() => []),
    ]);

    res.json({ ok: true, stats, keywordStats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 키워드 순위 ────────────────────────────────────────────────────
router.get('/rankings', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);

  const content = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;flex-wrap:wrap;gap:12px">
      <p style="color:#64748b;font-size:13px">입찰가 시뮬레이션 API로 예상 노출순위를 조회합니다.</p>
      <div style="display:flex;align-items:center;gap:10px">
        <select id="account-select" style="width:200px">
          ${accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('') || '<option value="">— 광고주 없음 —</option>'}
        </select>
        <button class="btn btn-primary" onclick="loadRankings()" id="rank-btn">순위 조회</button>
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <span class="card-title">📍 키워드 노출순위</span>
        <span id="rank-status" style="font-size:12px;color:#94a3b8"></span>
      </div>
      <div id="rank-wrap">
        <div class="empty">광고주를 선택하고 조회 버튼을 누르세요.<br>
        <span style="font-size:12px;color:#cbd5e1;margin-top:4px;display:block">키워드 수에 따라 1~2분 소요될 수 있습니다.</span></div>
      </div>
    </div>
    <script>
    async function loadRankings() {
      const id = document.getElementById('account-select').value;
      if (!id) return toast('광고주를 선택해주세요.', true);
      const btn = document.getElementById('rank-btn');
      btn.disabled = true; btn.textContent = '조회 중...';
      document.getElementById('rank-wrap').innerHTML = '<div class="empty"><span class="spinner"></span> 순위 조회 중...</div>';
      try {
        const res = await fetch('/smart-sa/api/rankings?accountId='+id);
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        const r = json.rankings;
        document.getElementById('rank-status').textContent = r.length+'개 키워드';
        if (!r.length) { document.getElementById('rank-wrap').innerHTML='<div class="empty">키워드 없음</div>'; return; }
        document.getElementById('rank-wrap').innerHTML = '<table><thead><tr>'
          +'<th>#</th><th>키워드</th><th style="text-align:right">입찰가</th><th style="text-align:center">예상순위</th><th>상태</th>'
          +'</tr></thead><tbody>'
          +r.map((kw,i)=>'<tr>'
            +'<td style="color:#94a3b8;text-align:center">'+(i+1)+'</td>'
            +'<td><strong>'+(kw.keyword||'-')+'</strong></td>'
            +'<td style="text-align:right">'+(kw.bidAmt!=null?'₩'+Number(kw.bidAmt).toLocaleString():'그룹적용')+'</td>'
            +'<td style="text-align:center">'+(kw.rank!=null?Number(kw.rank).toFixed(1)+'위':'-')+'</td>'
            +'<td>'+(kw.error?'<span class="badge badge-red">오류</span>':kw.rank==null?'<span class="badge badge-gray">데이터없음</span>':kw.rank<=3?'<span class="badge badge-green">상위</span>':'<span class="badge badge-blue">보통</span>')+'</td>'
            +'</tr>').join('')
          +'</tbody></table>';
      } catch(e) { toast('오류: '+e.message,true); document.getElementById('rank-wrap').innerHTML='<div class="empty">'+e.message+'</div>'; }
      finally { btn.disabled=false; btn.textContent='순위 재조회'; }
    }
    </script>
  `;
  res.send(appLayout('키워드 순위', content, user, 'rankings'));
});

router.get('/api/rankings', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const campaigns = await client.getCampaigns();
    const results = [];

    for (const camp of (campaigns || [])) {
      const adGroups = await client.getAdGroups(camp.nccCampaignId);
      for (const ag of (adGroups || [])) {
        const keywords = await client.getKeywords(ag.nccAdgroupId);
        for (const kw of (keywords || []).slice(0, 30)) {
          try {
            const sim = await client.getBidSimulation(kw.nccKeywordId);
            results.push({ keyword: kw.keyword, keywordId: kw.nccKeywordId, bidAmt: kw.bidAmt, rank: sim?.avgRnk ?? null });
          } catch (e) {
            results.push({ keyword: kw.keyword, keywordId: kw.nccKeywordId, bidAmt: kw.bidAmt, rank: null, error: e.message });
          }
          await new Promise(r => setTimeout(r, 150));
        }
      }
    }
    results.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    res.json({ ok: true, rankings: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 리포트 ─────────────────────────────────────────────────────────
router.get('/reports', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);

  const content = `
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:20px">
      ${['daily','weekly','monthly'].map(t => {
        const label = {daily:'일간',weekly:'주간',monthly:'월간'}[t];
        const desc  = {daily:'어제 하루 성과',weekly:'최근 7일 성과',monthly:'최근 30일 성과'}[t];
        return `<div class="card">
          <div class="card-body" style="text-align:center">
            <div style="font-size:32px;margin-bottom:12px">${{daily:'📅',weekly:'📆',monthly:'🗓'}[t]}</div>
            <h3 style="font-weight:600;margin-bottom:6px">${label} 리포트</h3>
            <p style="color:#64748b;font-size:12px;margin-bottom:16px">${desc}</p>
            <select id="acc-${t}" style="margin-bottom:10px">
              ${accounts.map(a=>`<option value="${a.id}">${a.name}</option>`).join('')||'<option value="">광고주 없음</option>'}
            </select>
            <button class="btn btn-primary" style="width:100%;justify-content:center" onclick="triggerReport('${t}')">발송</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">⏰ 자동 발송 스케줄</span></div>
      <div class="card-body">
        <table>
          <thead><tr><th>리포트</th><th>스케줄</th><th>시각</th><th>광고주별 설정</th></tr></thead>
          <tbody>
            <tr><td>일간</td><td><code>0 8 * * *</code></td><td>매일 08:00 KST</td><td>광고주 설정에서 ON/OFF</td></tr>
            <tr><td>주간</td><td><code>0 9 * * 1</code></td><td>월요일 09:00 KST</td><td>광고주 설정에서 ON/OFF</td></tr>
            <tr><td>월간</td><td><code>0 9 1 * *</code></td><td>매월 1일 09:00 KST</td><td>광고주 설정에서 ON/OFF</td></tr>
          </tbody>
        </table>
      </div>
    </div>
    <script>
    async function triggerReport(type) {
      const id = document.getElementById('acc-'+type).value;
      if (!id) return toast('광고주를 선택해주세요.', true);
      try {
        const res = await fetch('/smart-sa/api/report/trigger', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({type, accountId: id})
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        const labels = {daily:'일간',weekly:'주간',monthly:'월간'};
        toast(labels[type]+' 리포트 발송 시작!');
      } catch(e) { toast(e.message, true); }
    }
    </script>
  `;
  res.send(appLayout('리포트', content, user, 'reports'));
});

router.post('/api/report/trigger', requireLogin, async (req, res) => {
  const { type, accountId } = req.body;
  if (!['daily','weekly','monthly'].includes(type)) return res.status(400).json({ ok:false, error:'잘못된 타입' });
  const account = await db.getAccountById(accountId, req.session.userId);
  if (!account) return res.status(404).json({ ok:false, error:'광고주 없음' });

  const creds = await db.getApiCredentials(req.session.userId);
  if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

  // account에 API 자격증명 병합
  const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };
  generateAndSend(enriched, type).catch(console.error);
  res.json({ ok: true });
});

// ─── Vercel Cron 엔드포인트 ────────────────────────────────────────
// Vercel이 UTC 기준으로 호출 (한국시간 = UTC+9)
// daily: UTC 23:00 = KST 08:00
// weekly: UTC 00:00 MON = KST 09:00 MON
// monthly: UTC 00:00 1st = KST 09:00 1st
['daily', 'weekly', 'monthly'].forEach(type => {
  router.get(`/api/cron/${type}`, async (req, res) => {
    // Vercel Cron 인증 헤더 확인
    const authHeader = req.headers.authorization;
    if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    try {
      const accounts = await db.getAllAccountsWithFeature(`${type}_report`);
      let sent = 0;
      for (const account of accounts) {
        await generateAndSend(account, type).catch(console.error);
        sent++;
      }
      console.log(`✅ Vercel Cron [${type}]: ${sent}개 계정 처리`);
      res.json({ ok: true, type, sent });
    } catch (err) {
      console.error(`❌ Vercel Cron [${type}]:`, err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
});

module.exports = { router };
