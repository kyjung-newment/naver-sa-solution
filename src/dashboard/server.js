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
  .sidebar-logo{font-size:16px;font-weight:700;color:#ffffff}
  .sidebar-sub{font-size:11px;color:#9ca3af;margin-top:3px}
  .sidebar-section{padding:12px 12px 4px;font-size:10px;color:rgba(255,255,255,.3);text-transform:uppercase;letter-spacing:.08em}
  .sidebar-link{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13px;color:rgba(255,255,255,.7);cursor:pointer;transition:all .15s;margin:1px 8px;border:none;background:transparent;width:calc(100%-16px)}
  .sidebar-link:hover,.sidebar-link.active{background:rgba(255,255,255,.1);color:#fff}
  .sidebar-footer{margin-top:auto;padding:16px;border-top:1px solid rgba(255,255,255,.1)}
  .sidebar-user{font-size:13px;color:rgba(255,255,255,.7)}
  .main{margin-left:240px;min-height:100vh}
  .topbar{background:#fff;border-bottom:1px solid #e2e8f0;padding:0 24px;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
  .topbar-title{font-size:16px;font-weight:700}
  .content{padding:24px}
  .kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:20px}
  @media(max-width:1100px){.kpi-grid{grid-template-columns:repeat(2,1fr)}}
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
<title>${title} - 뉴먼트 솔루션</title>
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

function appLayout(title, content, user, activeMenu, opts = {}) {
  const accounts = opts.accounts || [];
  const selectedAccountId = opts.selectedAccountId || '';

  const menuItems = [
    { id: 'dashboard', icon: '📊', label: '성과 대시보드', href: '/smart-sa' },
    { id: 'autobid',   icon: '🎯', label: '자동입찰',      href: '/smart-sa/autobid' },
    { id: 'reports',   icon: '📧', label: '리포트',        href: '/smart-sa/reports' },
    { id: 'accounts',  icon: '🏢', label: '광고주 관리',   href: '/smart-sa/accounts' },
    { id: 'api',       icon: '🔑', label: 'API 설정',      href: '/smart-sa/api-settings' },
  ];
  if (user?.is_admin) {
    menuItems.push({ id: 'admin', icon: '👥', label: '직원 관리', href: '/smart-sa/admin/users' });
  }

  const accountSelector = accounts.length > 0 ? `
    <div style="padding:8px 12px;border-bottom:1px solid rgba(255,255,255,.1)">
      <label style="font-size:10px;color:rgba(255,255,255,.35);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:4px">광고주 선택</label>
      <select id="account-selector" onchange="switchAccount(this.value)"
        style="width:100%;padding:7px 10px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:#334155;color:#fff;font-size:13px;cursor:pointer">
        <option value="">전체 광고주</option>
        ${accounts.map(a => `<option value="${a.id}" ${String(a.id) === String(selectedAccountId) ? 'selected' : ''}>${a.name} (${a.customer_id})</option>`).join('')}
      </select>
    </div>
    <script>
    function switchAccount(accountId) {
      fetch('/smart-sa/api/select-account', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({accountId})
      }).then(() => location.reload());
    }
    </script>
  ` : '';

  const sidebar = `
  <div class="sidebar">
    <div class="sidebar-header">
      <div class="sidebar-logo">뉴먼트 솔루션</div>
      <div class="sidebar-sub">Newment solution Naver SA</div>
    </div>
    ${accountSelector}
    <div style="padding:8px">
      ${menuItems.map(m => `
        <a href="${m.href}" class="sidebar-link ${activeMenu === m.id ? 'active' : ''}">
          <span>${m.icon}</span><span>${m.label}</span>
        </a>
      `).join('')}
    </div>
    <div class="sidebar-footer">
      <a href="/smart-sa/profile" class="sidebar-link ${activeMenu === 'profile' ? 'active' : ''}" style="margin-bottom:4px">
        <span>👤</span><span>${user?.name || user?.username}</span>
      </a>
      <a href="/smart-sa/logout" class="sidebar-link" style="padding:6px 12px">↩ 로그아웃</a>
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
          <h1 style="font-size:22px;font-weight:700;color:#111827">뉴먼트 솔루션</h1>
          <p style="color:#9ca3af;margin-top:6px;font-size:13px">Newment solution Naver SA</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${err === 'invalid' ? '<div class="alert alert-err">아이디 또는 비밀번호가 올바르지 않습니다.</div>' : ''}
            ${isFirst ? '<div class="alert alert-ok">최초 실행입니다. 관리자 계정을 생성해주세요.</div>' : ''}
            <form method="POST" action="${isFirst ? '/smart-sa/register' : '/smart-sa/login'}">
              <div class="form-group">
                <label>${isFirst ? '아이디 (영문)' : '아이디'}</label>
                <input name="username" id="login-username" required placeholder="username" autocomplete="username">
              </div>
              ${isFirst ? `<div class="form-group"><label>이름</label><input name="name" required placeholder="홍길동"></div>` : ''}
              <div class="form-group">
                <label>비밀번호</label>
                <input type="password" name="password" required placeholder="••••••••" autocomplete="current-password">
              </div>
              ${!isFirst ? `
              <div style="display:flex;gap:16px;margin-top:8px;font-size:13px;color:#64748b;white-space:nowrap">
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap">
                  <input type="checkbox" id="save-id" style="accent-color:#03c75a"> 아이디 저장
                </label>
                <label style="display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap">
                  <input type="checkbox" name="remember" value="1" style="accent-color:#03c75a"> 로그인 유지
                </label>
              </div>` : ''}
              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px">
                ${isFirst ? '계정 생성 후 로그인' : '로그인'}
              </button>
            </form>
            ${!isFirst ? `
            <div style="text-align:center;margin-top:16px;padding-top:16px;border-top:1px solid #f1f5f9">
              <span style="font-size:13px;color:#64748b">계정이 없으신가요?</span>
              <a href="/smart-sa/signup" style="font-size:13px;color:#03c75a;font-weight:600;margin-left:6px">회원가입</a>
            </div>
            <div style="text-align:center;margin-top:8px">
              <a href="/smart-sa/reset-password" style="font-size:12px;color:#94a3b8">비밀번호를 잊으셨나요?</a>
            </div>
            <script>
            (function(){
              var saved = localStorage.getItem('savedUsername');
              if(saved){document.getElementById('login-username').value=saved;document.getElementById('save-id').checked=true;}
              document.querySelector('form').addEventListener('submit',function(){
                var cb=document.getElementById('save-id');
                if(cb&&cb.checked) localStorage.setItem('savedUsername',document.getElementById('login-username').value);
                else localStorage.removeItem('savedUsername');
              });
            })();
            </script>` : ''}
          </div>
        </div>
      </div>
    </div>
  `));
});

router.post('/login', async (req, res) => {
  const { username, password, remember } = req.body;
  const user = await db.authenticateUser(username, password);
  if (!user) return res.redirect(303, '/smart-sa/login?err=invalid');
  // 로그인 유지: 30일, 기본: 8시간
  if (remember === '1') req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
  req.session.userId = user.id;
  req.session.userName = user.name;
  req.session.isAdmin = !!user.is_admin;
  req.session.approved = user.approved;
  req.session.save(() => res.redirect(303, '/smart-sa'));
});

router.post('/register', async (req, res) => {
  const { username, password, name } = req.body;
  try {
    const count = await db.countUsers();
    if (count > 0) return res.redirect(303, '/smart-sa/login');
    // 최초 사용자는 관리자 + 승인 완료
    const id = await db.createUser(username, password, name || username, { isAdmin: true, approved: true });
    req.session.userId = id;
    req.session.userName = name || username;
    req.session.isAdmin = true;
    req.session.approved = 1;
    req.session.save(() => res.redirect(303, '/smart-sa'));
  } catch (e) {
    res.redirect(303, '/smart-sa/login?err=taken');
  }
});

router.get('/signup', (req, res) => {
  if (req.session.userId) return res.redirect('/smart-sa');
  const err = req.query.err || '';
  res.send(layout('회원가입', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#f0f9ff,#f0fdf4)">
      <div style="width:100%;max-width:440px;padding:16px">
        <div style="text-align:center;margin-bottom:32px">
          <div style="font-size:40px;margin-bottom:8px">📊</div>
          <h1 style="font-size:22px;font-weight:700;color:#111827">뉴먼트 솔루션</h1>
          <p style="color:#9ca3af;margin-top:6px;font-size:13px">Newment solution Naver SA</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${err === 'taken' ? '<div class="alert alert-err">이미 사용 중인 아이디입니다.</div>' : ''}
            <form method="POST" action="/smart-sa/signup">
              <div style="font-size:13px;font-weight:600;color:#374151;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid #e5e7eb">솔루션 계정</div>
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

              <div style="font-size:13px;font-weight:600;color:#374151;margin:20px 0 8px;padding-bottom:6px;border-bottom:1px solid #e5e7eb">다우오피스 연동</div>
              <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:12px;color:#92400e;line-height:1.6">
                <strong>⚠️ 리포트 이메일 발송에 사용됩니다.</strong><br>
                다우오피스 정보가 정확해야 리포트 발송이 정상적으로 진행됩니다.
              </div>
              <div class="form-group">
                <label>다우오피스 이메일</label>
                <input name="daou_email" required placeholder="user@newment.co.kr" type="email">
              </div>
              <div class="form-group">
                <label>다우오피스 비밀번호</label>
                <input type="password" name="daou_pass" required placeholder="다우오피스 로그인 비밀번호">
              </div>

              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:12px">계정 생성</button>
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
  const { username, password, name, daou_email, daou_pass } = req.body;
  try {
    // 승인 대기(approved=0) 상태로 생성
    const id = await db.createUser(username, password, name || username, { isAdmin: false, approved: false });
    // 다우오피스 정보 저장
    if (daou_email && daou_pass) {
      await db.pool.query('UPDATE users SET daou_email = $1, smtp_pass = $2 WHERE id = $3', [daou_email, daou_pass, id]).catch(() => {});
    }
    req.session.userId = id;
    req.session.userName = name || username;
    req.session.isAdmin = false;
    req.session.approved = 0;
    req.session.save(() => res.redirect(303, '/smart-sa/pending'));
  } catch (e) {
    res.redirect(303, '/smart-sa/signup?err=taken');
  }
});

// ─── 내 정보 ──────────────────────────────────────────────────────────
router.get('/profile', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const smtp = await db.getSmtpCredentials(req.session.userId);
  const msg = req.query.msg || '';
  const content = `
    <h2>내 정보</h2>
    ${msg === 'saved' ? '<div class="alert alert-ok">저장되었습니다.</div>' : ''}
    ${msg === 'smtp_ok' ? '<div class="alert alert-ok">다우오피스 정보가 업데이트되었습니다.</div>' : ''}
    ${msg === 'pw_err' ? '<div class="alert alert-err">현재 비밀번호가 올바르지 않습니다.</div>' : ''}
    ${msg === 'pw_ok' ? '<div class="alert alert-ok">솔루션 비밀번호가 변경되었습니다.</div>' : ''}
    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><span class="card-title">계정 정보</span></div>
      <div class="card-body">
        <div class="form-row">
          <div class="form-group"><label>아이디</label><input value="${user.username}" disabled></div>
          <div class="form-group"><label>이름</label><input value="${user.name}" disabled></div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <div class="card-header"><span class="card-title">다우오피스 연동 (이메일 발송용)</span></div>
      <div class="card-body">
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#92400e;line-height:1.6">
          <strong>⚠️ 다우오피스 정보가 정확해야 리포트 이메일 발송이 정상적으로 진행됩니다.</strong><br>
          다우오피스 비밀번호를 변경한 경우, 아래에서 반드시 업데이트해주세요.
        </div>
        <form method="POST" action="/smart-sa/profile/smtp">
          <div class="form-row">
            <div class="form-group"><label>다우오피스 이메일</label><input name="daou_email" value="${smtp?.daou_email || ''}" required placeholder="user@newment.co.kr" type="email"></div>
            <div class="form-group"><label>다우오피스 비밀번호</label><input type="password" name="daou_pass" value="${smtp?.smtp_pass || ''}" required placeholder="다우오피스 로그인 비밀번호"></div>
          </div>
          <button class="btn btn-primary" style="margin-top:8px">저장</button>
        </form>
      </div>
    </div>

    <div class="card">
      <div class="card-header"><span class="card-title">솔루션 비밀번호 변경</span></div>
      <div class="card-body">
        <form method="POST" action="/smart-sa/profile/password">
          <div class="form-group"><label>현재 비밀번호</label><input type="password" name="current_pw" required></div>
          <div class="form-row">
            <div class="form-group"><label>새 비밀번호</label><input type="password" name="new_pw" required minlength="6"></div>
            <div class="form-group"><label>새 비밀번호 확인</label><input type="password" name="new_pw2" required minlength="6"></div>
          </div>
          <button class="btn btn-outline" style="margin-top:8px">비밀번호 변경</button>
        </form>
      </div>
    </div>
  `;
  res.send(appLayout('내 정보', content, user, 'profile', await getLayoutOpts(req)));
});

router.post('/profile/smtp', requireLogin, async (req, res) => {
  const { daou_email, daou_pass } = req.body;
  await db.pool.query('UPDATE users SET daou_email = $1, smtp_pass = $2 WHERE id = $3', [daou_email, daou_pass, req.session.userId]);
  res.redirect(303, '/smart-sa/profile?msg=smtp_ok');
});

router.post('/profile/password', requireLogin, async (req, res) => {
  const { current_pw, new_pw, new_pw2 } = req.body;
  if (new_pw !== new_pw2) return res.redirect(303, '/smart-sa/profile?msg=pw_err');
  const user = await db.getUserByUsername((await getUser(req)).username);
  const { verifyPassword, hashPassword } = require('../db/database');
  // verifyPassword is not exported, check inline
  const [salt, hash] = user.password_hash.split(':');
  const crypto = require('crypto');
  const attempt = crypto.scryptSync(current_pw, salt, 64).toString('hex');
  if (attempt !== hash) return res.redirect(303, '/smart-sa/profile?msg=pw_err');
  const newHash = (() => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(new_pw, s, 64).toString('hex'); })();
  await db.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.session.userId]);
  res.redirect(303, '/smart-sa/profile?msg=pw_ok');
});

router.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/smart-sa/login'));
});

// ─── 관리자 비밀번호 초기화 (CRON_SECRET 필요) ───────────────────────
router.get('/reset-password', (req, res) => {
  const secret = req.query.secret || '';
  const msg = req.query.msg || '';
  const validSecret = secret === process.env.CRON_SECRET;

  res.send(layout('비밀번호 초기화', `
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#fff7ed,#fef2f2)">
      <div style="width:100%;max-width:420px;padding:16px">
        <div style="text-align:center;margin-bottom:24px">
          <div style="font-size:40px">🔑</div>
          <h1 style="font-size:20px;font-weight:700;color:#111827;margin-top:8px">관리자 비밀번호 초기화</h1>
          <p style="color:#64748b;font-size:13px;margin-top:4px">보안 코드가 있어야 사용 가능합니다</p>
        </div>
        <div class="card">
          <div class="card-body">
            ${msg === 'done' ? '<div class="alert alert-ok">✅ 비밀번호가 초기화되었습니다. 새 비밀번호로 로그인하세요.</div>' : ''}
            ${msg === 'fail' ? '<div class="alert alert-err">❌ 보안 코드가 올바르지 않습니다.</div>' : ''}
            ${msg === 'err' ? '<div class="alert alert-err">❌ 초기화 중 오류가 발생했습니다.</div>' : ''}
            <form method="POST" action="/smart-sa/reset-password">
              <div class="form-group">
                <label>보안 코드 (CRON_SECRET)</label>
                <input name="secret" type="password" required placeholder="보안 코드 입력" value="${validSecret ? secret : ''}">
              </div>
              <div class="form-group">
                <label>새 비밀번호</label>
                <input name="new_password" type="password" required placeholder="새 비밀번호 (8자 이상)" minlength="8">
              </div>
              <div class="form-group">
                <label>새 비밀번호 확인</label>
                <input name="confirm_password" type="password" required placeholder="비밀번호 재입력">
              </div>
              <button class="btn btn-primary" style="width:100%;justify-content:center;margin-top:8px;background:#ef4444;border-color:#ef4444">비밀번호 초기화</button>
            </form>
            <div style="text-align:center;margin-top:16px">
              <a href="/smart-sa/login" style="font-size:13px;color:#64748b">← 로그인으로 돌아가기</a>
            </div>
          </div>
        </div>
      </div>
    </div>
  `));
});

router.post('/reset-password', async (req, res) => {
  const { secret, new_password, confirm_password } = req.body;
  if (secret !== process.env.CRON_SECRET) return res.redirect(303, '/smart-sa/reset-password?msg=fail');
  if (new_password !== confirm_password || new_password.length < 8) return res.redirect(303, '/smart-sa/reset-password?msg=err');
  try {
    await db.resetAdminPassword(new_password);
    res.redirect(303, '/smart-sa/reset-password?msg=done');
  } catch (e) {
    console.error('비밀번호 초기화 오류:', e);
    res.redirect(303, '/smart-sa/reset-password?msg=err');
  }
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
  res.send(appLayout('직원 관리', content, user, 'admin', await getLayoutOpts(req)));
});

router.post('/admin/users/:id/approve', requireLogin, requireAdmin, async (req, res) => {
  await db.approveUser(req.params.id);
  res.redirect(303, '/smart-sa/admin/users?msg=approved');
});

router.post('/admin/users/:id/reject', requireLogin, requireAdmin, async (req, res) => {
  await db.rejectUser(req.params.id);
  res.redirect(303, '/smart-sa/admin/users?msg=rejected');
});

// ─── 헬퍼 ──────────────────────────────────────────────────────────
async function getUser(req) {
  return db.getUserById(req.session.userId);
}

// 사용자의 API 자격증명으로 특정 광고주(customerId)용 API 클라이언트 생성
// 레이아웃에 전달할 공통 옵션 (광고주 목록 + 선택된 광고주)
async function getLayoutOpts(req) {
  if (!req.session.userId) return {};
  try {
    const accounts = await db.getAccountsByUser(req.session.userId);
    return {
      accounts,
      selectedAccountId: req.session.selectedAccountId || '',
    };
  } catch (e) { return {}; }
}

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

  res.send(appLayout('API 설정', content, user, 'api', await getLayoutOpts(req)));
});

router.post('/api-settings', requireLogin, async (req, res) => {
  const { api_key, secret_key, manager_customer_id } = req.body;

  // API 연결 테스트 (/ncc/campaigns로 검증 - 모든 계정 유형에서 작동)
  try {
    const testClient = createApiClient({ apiKey: api_key, secretKey: secret_key, customerId: manager_customer_id });
    await testClient.getCampaigns();
  } catch (e) {
    console.log('API 테스트 실패:', e.message);
    return res.redirect(303, '/smart-sa/api-settings?msg=invalid');
  }

  await db.updateApiCredentials(req.session.userId, api_key, secret_key, manager_customer_id);
  res.redirect(303, '/smart-sa/api-settings?msg=saved');
});

// ─── 광고주 관리 (불러오기 + 선택 + 기능 설정) ──────────────────────
router.get('/accounts', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);
  const creds = req.apiCreds;
  const msg = req.query.msg || '';

  const existingCids = accounts.map(a => a.customer_id);

  const content = `
    ${msg === 'saved' ? '<div class="alert alert-ok">저장되었습니다.</div>' : ''}
    ${msg === 'deleted' ? '<div class="alert alert-err">삭제되었습니다.</div>' : ''}
    ${msg === 'added' ? '<div class="alert alert-ok">광고주가 추가되었습니다.</div>' : ''}

    <p style="color:#64748b;font-size:13px;margin-bottom:16px">마케터 API로 연동된 광고주를 조회하고, 솔루션 적용 대상을 선택합니다.</p>

    <!-- 연동 광고주 조회 (Customer ID 스캔) -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
        <span class="card-title">📡 연동 광고주 조회</span>
        <div style="display:flex;gap:8px">
          <button class="btn btn-primary btn-sm" id="scan-btn" onclick="scanCustomers()">🔍 광고주 자동 조회</button>
        </div>
      </div>
      <div class="card-body">
        <p style="font-size:13px;color:#64748b;margin-bottom:12px">
          운영관리 권한이 있는 광고주의 Customer ID를 입력하면 자동으로 접근 권한을 확인합니다.<br>
          여러 Customer ID를 쉼표(,)로 구분하여 한 번에 입력할 수 있습니다.
        </p>
        <div style="display:flex;gap:10px;margin-bottom:12px;align-items:flex-end">
          <div style="flex:1">
            <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px">Customer ID (쉼표로 구분)</label>
            <input id="scan-ids" placeholder="예: 1861934, 1234567, 9876543" style="width:100%">
          </div>
          <button class="btn btn-primary btn-sm" id="scan-ids-btn" onclick="scanByIds()">🔍 조회</button>
        </div>
        <div id="scan-result"></div>
      </div>
    </div>

    <!-- 광고주 수동 추가 -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">✏️ 광고주 수동 추가</span>
      </div>
      <div class="card-body">
        <details style="margin-bottom:10px">
          <summary style="cursor:pointer;font-size:13px;color:#64748b">자동 조회에 표시되지 않는 광고주를 Customer ID로 직접 추가합니다.</summary>
          <div style="margin-top:10px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:10px 14px;font-size:12px;color:#0369a1">
            <strong>📌 Customer ID 확인 방법 (광고계정 ID와 다릅니다!)</strong>
            <ol style="margin:6px 0 0 16px;line-height:1.8;color:#0c4a6e">
              <li>네이버 <a href="https://searchad.naver.com" target="_blank" style="color:#0284c7">검색광고 센터</a>에 로그인</li>
              <li>관리할 광고주 계정으로 <strong>전환</strong></li>
              <li>우측 상단의 <strong>검색광고 Key?</strong> 버튼 클릭</li>
              <li>표시된 <strong>CUSTOMER_ID</strong> 값을 복사</li>
            </ol>
            <p style="margin-top:6px;color:#b45309;font-size:11px">⚠️ 광고계정 ID(예: 1737106)와 Customer ID(예: 1484655)는 서로 다른 값입니다.</p>
          </div>
        </details>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div style="flex:1;min-width:200px">
            <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px">광고주명</label>
            <input id="add-name" placeholder="예: egojin" style="width:100%">
          </div>
          <div style="flex:1;min-width:150px">
            <label style="font-size:12px;font-weight:600;color:#374151;display:block;margin-bottom:4px">Customer ID</label>
            <input id="add-cid" placeholder="API 사용 관리에서 확인한 ID" style="width:100%">
          </div>
          <button class="btn btn-primary" id="add-btn" onclick="testAndAddCustomer()">🔍 확인 및 추가</button>
        </div>
        <div id="add-result" style="margin-top:8px"></div>
      </div>
    </div>

    <!-- 솔루션 적용 광고주 목록 -->
    <div class="card" style="margin-bottom:20px">
      <div class="card-header">
        <span class="card-title">🏢 솔루션 적용 광고주</span>
        <span style="font-size:12px;color:#94a3b8">${accounts.length}개</span>
      </div>
      ${accounts.length === 0
        ? '<div class="empty">위에서 광고주를 조회하거나 수동 추가하여<br>솔루션을 적용할 광고주를 등록해주세요.</div>'
        : `<table>
            <thead><tr><th>광고주명</th><th>Customer ID</th><th>네이버 마스터</th><th>활용 기능</th><th style="text-align:center">관리</th></tr></thead>
            <tbody>
              ${accounts.map(a => {
                const syncBadge = a.sync_status === 'synced'
                  ? `<span class="badge badge-green">동기화 완료</span><br><span style="font-size:10px;color:#94a3b8">캠페인 ${a.campaign_count || 0} / 그룹 ${a.adgroup_count || 0} / 키워드 ${a.keyword_count || 0}</span>`
                  : a.sync_status === 'syncing'
                  ? '<span class="badge badge-blue">동기화 중...</span>'
                  : '<span class="badge badge-gray">미동기화</span>';
                return `
                <tr>
                  <td><strong>${a.name}</strong></td>
                  <td style="font-family:monospace;font-size:13px;color:#64748b">${a.customer_id}</td>
                  <td>
                    ${syncBadge}<br>
                    <button class="btn btn-outline btn-sm" style="margin-top:4px;font-size:11px" onclick="syncMaster(${a.id},'${a.name}',this)">🔄 동기화</button>
                  </td>
                  <td>
                    ${a.feat_daily_report ? '<span class="badge badge-green" style="margin:2px">일간</span>' : ''}
                    ${a.feat_weekly_report ? '<span class="badge badge-green" style="margin:2px">주간</span>' : ''}
                    ${a.feat_monthly_report ? '<span class="badge badge-green" style="margin:2px">월간</span>' : ''}
                    ${a.feat_keyword_monitor ? '<span class="badge badge-blue" style="margin:2px">순위모니터</span>' : ''}
                    ${a.feat_auto_bidding ? '<span class="badge badge-blue" style="margin:2px">자동입찰</span>' : ''}
                    ${!a.feat_daily_report && !a.feat_weekly_report && !a.feat_monthly_report && !a.feat_keyword_monitor && !a.feat_auto_bidding ? '<span class="badge badge-gray">미설정</span>' : ''}
                  </td>
                  <td style="text-align:center">
                    <a href="/smart-sa/accounts/${a.id}/edit" class="btn btn-outline btn-sm">설정</a>
                    <button class="btn btn-danger btn-sm" style="margin-left:4px" onclick="deleteAccount(${a.id},'${a.name}')">제거</button>
                  </td>
                </tr>
              `}).join('')}
            </tbody>
          </table>`
      }
    </div>

    <!-- 마케터 API 연동 정보 -->
    <div class="card">
      <div class="card-header" style="display:flex;align-items:center;gap:8px">
        <span class="card-title">🔗 마케터 API 연동 정보</span>
        ${creds ? '<span class="badge badge-green">연동됨</span>' : '<span class="badge badge-gray">미연동</span>'}
      </div>
      <div class="card-body" style="font-size:13px">
        ${creds ? `
          <table style="width:100%;max-width:500px">
            <tr>
              <td style="padding:6px 12px;color:#64748b;font-weight:600;width:160px;border-bottom:1px solid #f1f5f9">마케터 Customer ID</td>
              <td style="padding:6px 12px;font-family:monospace;border-bottom:1px solid #f1f5f9">${creds.manager_customer_id}</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;color:#64748b;font-weight:600;border-bottom:1px solid #f1f5f9">API Key</td>
              <td style="padding:6px 12px;font-family:monospace;font-size:11px;border-bottom:1px solid #f1f5f9">${creds.api_key.substring(0, 20)}...</td>
            </tr>
            <tr>
              <td style="padding:6px 12px;color:#64748b;font-weight:600">연동 상태</td>
              <td style="padding:6px 12px"><span class="badge badge-green">정상</span></td>
            </tr>
          </table>
          <p style="margin-top:10px;font-size:12px;color:#94a3b8">
            이 마케터 API로 권한이 부여된 광고주 계정에 접근할 수 있습니다.
            <a href="/smart-sa/api-settings" style="color:#03c75a;margin-left:4px">설정 변경 →</a>
          </p>
        ` : `
          <p style="color:#ef4444">마케터 API가 연동되지 않았습니다. <a href="/smart-sa/api-settings" style="color:#03c75a;font-weight:600">API 설정</a>에서 먼저 등록해주세요.</p>
        `}
      </div>
    </div>

    <script>
    const existingCids = ${JSON.stringify(existingCids)};

    async function scanCustomers(testIds) {
      const btn = document.getElementById('scan-btn');
      const result = document.getElementById('scan-result');
      btn.disabled = true; btn.textContent = '조회 중...';
      result.innerHTML = '<div style="color:#64748b;font-size:13px;padding:8px 0">🔄 연동 광고주 조회 중... 계정 수에 따라 시간이 소요될 수 있습니다.</div>';

      try {
        const body = {};
        if (testIds) body.testIds = testIds;
        const res = await fetch('/smart-sa/api/list-customers', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(body)
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);

        if (json.customers.length === 0) {
          result.innerHTML = '<div class="alert alert-info">접근 가능한 광고주가 없습니다. Customer ID를 확인해주세요.</div>';
          return;
        }

        let html = '<table style="width:100%"><thead><tr><th style="width:40px"></th><th>광고주명</th><th>Customer ID</th><th>캠페인수</th><th>상태</th></tr></thead><tbody>';
        json.customers.forEach(c => {
          const already = existingCids.includes(String(c.customerId));
          html += '<tr>';
          html += '<td style="text-align:center">' + (already
            ? '<span class="badge badge-green" style="font-size:10px">등록됨</span>'
            : (c.accessible ? '<input type="checkbox" class="scan-check" data-cid="'+c.customerId+'" data-name="'+(c.name||c.customerId)+'" checked>' : '')) + '</td>';
          html += '<td><strong>'+(c.name || '-')+'</strong></td>';
          html += '<td style="font-family:monospace;font-size:13px;color:#64748b">'+c.customerId+'</td>';
          html += '<td style="text-align:center">'+(c.campaignCount || 0)+'</td>';
          html += '<td>' + (c.accessible ? '<span class="badge badge-green">접근가능</span>' : '<span class="badge badge-red">접근불가</span>') + '</td>';
          html += '</tr>';
        });
        html += '</tbody></table>';
        const hasAddable = json.customers.some(c => c.accessible && !existingCids.includes(String(c.customerId)));
        if (hasAddable) {
          html += '<div style="margin-top:12px;display:flex;gap:8px;align-items:center">';
          html += '<button class="btn btn-primary" onclick="addSelectedCustomers()">선택한 광고주 추가</button>';
          html += '<span style="font-size:12px;color:#94a3b8" id="scan-status"></span>';
          html += '</div>';
        }
        result.innerHTML = html;
      } catch(e) {
        result.innerHTML = '<div class="alert alert-err">조회 실패: ' + e.message + '</div>';
      } finally {
        btn.disabled = false; btn.textContent = '🔍 광고주 자동 조회';
      }
    }

    async function scanByIds() {
      const idsInput = document.getElementById('scan-ids').value.trim();
      if (!idsInput) { toast('Customer ID를 입력해주세요.', true); return; }
      const ids = idsInput.split(/[,\s]+/).map(s => s.trim()).filter(s => s);
      if (ids.length === 0) { toast('유효한 Customer ID를 입력해주세요.', true); return; }
      const btn = document.getElementById('scan-ids-btn');
      btn.disabled = true; btn.textContent = '조회 중...';
      await scanCustomers(ids);
      btn.disabled = false; btn.textContent = '🔍 조회';
    }

    async function addSelectedCustomers() {
      const checks = document.querySelectorAll('.scan-check:checked');
      if (checks.length === 0) { toast('추가할 광고주를 선택해주세요.', true); return; }
      const status = document.getElementById('scan-status');
      let added = 0;
      for (const chk of checks) {
        const cid = chk.dataset.cid;
        const name = chk.dataset.name;
        status.textContent = name + ' 추가 중...';
        try {
          const res = await fetch('/smart-sa/api/add-customer', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ customerId: cid, name })
          });
          const json = await res.json();
          if (json.ok) added++;
        } catch(e) {}
      }
      toast(added + '개 광고주가 추가되었습니다.');
      setTimeout(() => location.reload(), 1000);
    }

    async function testAndAddCustomer() {
      const nameEl = document.getElementById('add-name');
      const cidEl = document.getElementById('add-cid');
      const btn = document.getElementById('add-btn');
      const result = document.getElementById('add-result');
      const name = nameEl.value.trim();
      const customerId = cidEl.value.trim();

      if (!name || !customerId) {
        result.innerHTML = '<div class="alert alert-err">광고주명과 Customer ID를 모두 입력해주세요.</div>';
        return;
      }

      btn.disabled = true; btn.textContent = '확인 중...';
      result.innerHTML = '<div style="color:#64748b;font-size:13px">🔄 API 접근 권한 확인 중...</div>';

      try {
        const res = await fetch('/smart-sa/api/test-customer', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ customerId })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);

        if (json.accessible) {
          const addRes = await fetch('/smart-sa/api/add-customer', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify({ customerId, name })
          });
          const addJson = await addRes.json();
          if (!addJson.ok) throw new Error(addJson.error);
          result.innerHTML = '<div class="alert alert-ok">✅ ' + name + ' — API 연동 성공!</div>';
          toast(name + ' 광고주가 추가되었습니다.');
          setTimeout(() => location.reload(), 1500);
        } else {
          result.innerHTML = '<div class="alert alert-err">❌ 해당 Customer ID에 API 접근 권한이 없습니다.</div>';
        }
      } catch(e) {
        result.innerHTML = '<div class="alert alert-err">오류: ' + e.message + '</div>';
      } finally {
        btn.disabled = false; btn.textContent = '🔍 확인 및 추가';
      }
    }

    async function syncMaster(accountId, name, btnEl) {
      btnEl.disabled = true; btnEl.textContent = '동기화 중...';
      try {
        const res = await fetch('/smart-sa/api/sync-master', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ accountId })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        toast(name + ' 네이버 마스터 동기화 완료!');
        setTimeout(() => location.reload(), 1500);
      } catch(e) {
        toast('동기화 실패: ' + e.message, true);
        btnEl.disabled = false; btnEl.textContent = '🔄 동기화';
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
  res.send(appLayout('광고주 관리', content, user, 'accounts', { accounts, selectedAccountId: req.session.selectedAccountId || '' }));
});

// API: 연결된 광고주 목록 불러오기
router.get('/api/customer-links', requireLogin, async (req, res) => {
  try {
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    // 특정 Customer ID로 API 접근 가능 여부 테스트
    const client = makeClient(creds, creds.manager_customer_id);
    const campaigns = await client.getCampaigns();
    return res.json({
      ok: true,
      customers: [{
        customerId: parseInt(creds.manager_customer_id),
        customerName: `내 계정 (${creds.manager_customer_id})`,
        campaignCount: campaigns.length,
      }]
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 광고주 선택 (세션에 저장)
router.post('/api/select-account', requireLogin, (req, res) => {
  const { accountId } = req.body;
  req.session.selectedAccountId = accountId || '';
  req.session.save(() => res.json({ ok: true }));
});

// API: 연동 광고주 자동 조회 (customer-links + 마스터 리포트 기반 스캔)
router.post('/api/list-customers', requireLogin, async (req, res) => {
  try {
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    const customers = [];
    const seenCids = new Set();

    // 1. 마케터 자신의 계정
    try {
      const selfClient = makeClient(creds, creds.manager_customer_id);
      const camps = await selfClient.getCampaigns();
      customers.push({
        customerId: creds.manager_customer_id,
        name: '마케터 계정 (' + creds.manager_customer_id + ')',
        accessible: true,
        campaignCount: camps.length,
      });
      seenCids.add(creds.manager_customer_id);
    } catch (e) {}

    // 2. customer-links API 시도 (매니저 계정용)
    try {
      const client = makeClient(creds, creds.manager_customer_id);
      const links = await client.getCustomerLinks();
      if (Array.isArray(links)) {
        for (const link of links) {
          const cid = String(link.clientCustomerId || link.customerId || link.id);
          if (seenCids.has(cid)) continue;
          seenCids.add(cid);
          let accessible = false;
          let campCount = 0;
          let accountName = link.clientLoginId || link.loginId || cid;
          try {
            const c = makeClient(creds, cid);
            const camps = await c.getCampaigns();
            accessible = true;
            campCount = camps.length;
          } catch (e) {}
          customers.push({ customerId: cid, name: accountName, accessible, campaignCount: campCount });
        }
      }
    } catch (e) {
      // customer-links 미지원 계정 — 무시
    }

    // 3. 추가 Customer ID 스캔 (요청 body에 테스트할 ID 목록 포함 시)
    const { testIds } = req.body || {};
    if (Array.isArray(testIds)) {
      for (const cid of testIds) {
        const cidStr = String(cid).trim();
        if (!cidStr || seenCids.has(cidStr)) continue;
        seenCids.add(cidStr);
        try {
          const c = makeClient(creds, cidStr);
          const camps = await c.getCampaigns();
          // 캠페인 이름에서 공통 접두어 추출하여 광고주명 유추
          let accountName = cidStr;
          if (camps.length > 0) {
            const firstName = camps[0].name || '';
            const match = firstName.match(/^[^_]+_(.+)$/);
            accountName = match ? match[1] : firstName;
          }
          customers.push({ customerId: cidStr, name: accountName, accessible: true, campaignCount: camps.length });
        } catch (e) {
          // 접근 불가 — 스킵
        }
      }
    }

    res.json({ ok: true, customers, source: customers.length > 1 ? 'scan' : 'self' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 광고주 Customer ID 접근 권한 테스트
router.post('/api/test-customer', requireLogin, async (req, res) => {
  try {
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ ok: false, error: 'Customer ID를 입력해주세요.' });

    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    // 해당 Customer ID로 캠페인 조회 시도
    const client = makeClient(creds, String(customerId));
    try {
      const campaigns = await client.getCampaigns();
      return res.json({ ok: true, accessible: true, campaignCount: campaigns.length });
    } catch (apiErr) {
      const status = apiErr.message.match(/\[(\d+)\]/)?.[1];
      if (status === '403') {
        return res.json({ ok: true, accessible: false, error: 'API 접근 권한 없음' });
      }
      return res.json({ ok: true, accessible: false, error: apiErr.message });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// API: 네이버 마스터 동기화
router.post('/api/sync-master', requireLogin, async (req, res) => {
  try {
    const { accountId } = req.body;
    if (!accountId) return res.status(400).json({ ok: false, error: 'Account ID 필요' });

    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주를 찾을 수 없습니다.' });

    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정을 먼저 등록해주세요.' });

    // 동기화 상태 업데이트
    await db.updateSyncStatus(accountId, 'syncing');

    const client = makeClient(creds, account.customer_id);

    // 캠페인 마스터 동기화
    let campaignCount = 0, adgroupCount = 0, keywordCount = 0;
    try {
      const campRows = await client.syncMaster('Campaign');
      await db.upsertMasterCampaigns(accountId, campRows);
      campaignCount = campRows.length;
    } catch (e) { console.log('캠페인 마스터 동기화 실패:', e.message); }

    // 광고그룹 마스터 동기화
    try {
      const agRows = await client.syncMaster('Adgroup');
      await db.upsertMasterAdgroups(accountId, agRows);
      adgroupCount = agRows.length;
    } catch (e) { console.log('광고그룹 마스터 동기화 실패:', e.message); }

    // 키워드 마스터 동기화
    try {
      const kwRows = await client.syncMaster('Keyword');
      await db.upsertMasterKeywords(accountId, kwRows);
      keywordCount = kwRows.length;
    } catch (e) { console.log('키워드 마스터 동기화 실패:', e.message); }

    await db.updateSyncStatus(accountId, 'synced', {
      campaigns: campaignCount,
      adgroups: adgroupCount,
      keywords: keywordCount,
    });

    res.json({
      ok: true,
      counts: { campaigns: campaignCount, adgroups: adgroupCount, keywords: keywordCount },
    });
  } catch (err) {
    console.error('마스터 동기화 오류:', err);
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
function accountSettingsForm(account = {}, smtpInfo = {}) {
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
        <div class="card-header"><span class="card-title">이메일 발송 설정</span></div>
        <div class="card-body">
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:14px 18px;margin-bottom:16px">
            <div style="font-size:13px;font-weight:600;color:#16a34a">✅ SMTP 자동 연동</div>
            <div style="font-size:12px;color:#14532d;margin-top:4px">다우오피스 계정으로 자동 발송됩니다. 별도 설정 불필요.</div>
            <div style="font-size:12px;color:#64748b;margin-top:4px">발신: <strong>${smtpInfo?.daou_email || '미설정'}</strong> → 수신: 위 리포트 수신 이메일</div>
            ${!smtpInfo?.daou_email ? '<div style="font-size:12px;color:#dc2626;margin-top:4px">⚠️ <a href="/smart-sa/profile" style="color:#dc2626;font-weight:600">내 정보</a>에서 다우오피스 이메일을 설정해주세요.</div>' : ''}
          </div>
          <input type="hidden" name="email_host" value="${v('email_host','smtp.daouoffice.com')}">
          <input type="hidden" name="email_port" value="${v('email_port',587)}">
          <input type="hidden" name="email_user" value="${v('email_user','')}">
          <input type="hidden" name="email_pass" value="${v('email_pass','')}">
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
  const smtpInfo = await db.getSmtpCredentials(user.id);
  res.send(appLayout(account.name + ' 설정', accountSettingsForm(account, smtpInfo), user, 'accounts', await getLayoutOpts(req)));
});

router.post('/accounts/:id/edit', requireLogin, async (req, res) => {
  const user = await getUser(req);
  const data = { ...req.body };
  ['feat_daily_report','feat_weekly_report','feat_monthly_report','feat_keyword_monitor','feat_auto_bidding']
    .forEach(k => { data[k] = k in req.body; });
  await db.updateAccount(req.params.id, user.id, data);
  res.redirect(303, '/smart-sa/accounts?msg=saved');
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
    <!-- 기간 선택 + 광고주 -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="period-tabs">
          <button class="period-btn active" data-period="yesterday">어제</button>
          <button class="period-btn" data-period="7days">최근 7일</button>
          <button class="period-btn" data-period="30days">최근 30일</button>
          <button class="period-btn" data-period="custom" id="custom-period-btn">기간 선택</button>
        </div>
        <div id="custom-date-wrap" style="display:none;align-items:center;gap:6px">
          <input type="date" id="date-start" style="width:140px;padding:6px 10px;font-size:13px">
          <span style="color:#94a3b8">~</span>
          <input type="date" id="date-end" style="width:140px;padding:6px 10px;font-size:13px">
          <button class="btn btn-primary btn-sm" onclick="applyCustomDate()">적용</button>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:13px;color:#64748b" id="selected-account-label">
          ${req.session.selectedAccountId
            ? accounts.find(a => String(a.id) === String(req.session.selectedAccountId))?.name || '전체'
            : '전체 광고주'}
        </span>
      </div>
    </div>

    <!-- 탭 메뉴 -->
    <div style="display:flex;gap:0;border-bottom:2px solid #e2e8f0;margin-bottom:20px">
      ${['summary','keywords','hourly','target','adgroups'].map((tab, i) => {
        const labels = ['요약','키워드별','시간대별','타겟별','그룹별'];
        return `<button class="dash-tab ${i===0?'active':''}" data-tab="${tab}" onclick="switchTab('${tab}')"
          style="padding:10px 20px;font-size:13px;font-weight:600;background:none;border:none;cursor:pointer;color:${i===0?'#03c75a':'#94a3b8'};border-bottom:2px solid ${i===0?'#03c75a':'transparent'};margin-bottom:-2px;transition:all .15s">${labels[i]}</button>`;
      }).join('')}
    </div>

    <!-- 요약 탭 -->
    <div id="tab-summary" class="tab-content">
      <div class="kpi-grid" id="kpi-grid">
        ${['노출수','클릭수','CTR','총비용','구매완료전환매출','ROAS','평균순위','구매완료전환수'].map(l => `
          <div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value" style="color:#e2e8f0">—</div></div>
        `).join('')}
      </div>
      <div id="chart-wrap" class="card" style="margin-bottom:20px;display:none">
        <div class="card-header"><span class="card-title">캠페인별 비용 vs 구매완료매출</span></div>
        <div class="card-body" id="chart-body"></div>
      </div>
    </div>

    <!-- 키워드별 탭 -->
    <div id="tab-keywords" class="tab-content" style="display:none">
      <div id="kw-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <!-- 시간대별 탭 -->
    <div id="tab-hourly" class="tab-content" style="display:none">
      <div id="hourly-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <!-- 타겟별 탭 -->
    <div id="tab-target" class="tab-content" style="display:none">
      <div id="target-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <!-- 그룹별 탭 -->
    <div id="tab-adgroups" class="tab-content" style="display:none">
      <div id="adgroups-tab-content"><div class="empty">탭을 선택하면 데이터를 로딩합니다.</div></div>
    </div>

    <script>
    let currentPeriod = 'yesterday';
    let customStart = '', customEnd = '';
    const tabLoaded = {};
    const selectedAccountId = '${req.session.selectedAccountId || ''}';
    // firstAccountId 제거 - 광고주 선택 필수

    function getAccountId() { return selectedAccountId; }
    function periodParams() {
      let p = 'period='+currentPeriod+'&accountId='+getAccountId();
      if (currentPeriod === 'custom') p += '&startDate='+customStart+'&endDate='+customEnd;
      return p;
    }

    // 기간 버튼
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.period === 'custom') {
          document.getElementById('custom-date-wrap').style.display = 'flex';
          // 기본값: 최근 7일
          const today = new Date();
          const end = new Date(today); end.setDate(end.getDate()-1);
          const start = new Date(today); start.setDate(start.getDate()-7);
          document.getElementById('date-start').value = start.toISOString().slice(0,10);
          document.getElementById('date-end').value = end.toISOString().slice(0,10);
          return;
        }
        document.getElementById('custom-date-wrap').style.display = 'none';
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentPeriod = btn.dataset.period;
        resetTabs();
        loadCurrentTab();
      });
    });

    function applyCustomDate() {
      const s = document.getElementById('date-start').value;
      const e = document.getElementById('date-end').value;
      if (!s || !e) return toast('시작/종료일을 선택해주세요.', true);
      if (s > e) return toast('시작일이 종료일보다 큽니다.', true);
      customStart = s; customEnd = e;
      currentPeriod = 'custom';
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('custom-period-btn').classList.add('active');
      resetTabs();
      loadCurrentTab();
    }

    function resetTabs() { for (const k in tabLoaded) tabLoaded[k] = false; }

    let currentTab = 'summary';
    function switchTab(name) {
      currentTab = name;
      document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
      document.getElementById('tab-'+name).style.display = 'block';
      document.querySelectorAll('.dash-tab').forEach(b => {
        const isActive = b.dataset.tab === name;
        b.style.color = isActive ? '#03c75a' : '#94a3b8';
        b.style.borderBottomColor = isActive ? '#03c75a' : 'transparent';
        if (isActive) b.classList.add('active'); else b.classList.remove('active');
      });
      loadCurrentTab();
    }

    function loadCurrentTab() {
      if (!getAccountId()) { toast('사이드바에서 광고주를 선택해주세요.', true); return; }
      if (currentTab === 'summary') loadSummary();
      else if (currentTab === 'keywords' && !tabLoaded.keywords) loadKeywords();
      else if (currentTab === 'hourly' && !tabLoaded.hourly) loadHourly();
      else if (currentTab === 'target' && !tabLoaded.target) loadDevice();
      else if (currentTab === 'adgroups' && !tabLoaded.adgroups) loadAdgroups();
    }

    // 페이지 로드 시 자동 조회 (광고주 선택된 경우만)
    if (getAccountId()) {
      setTimeout(() => loadSummary(), 300);
    } else {
      document.getElementById('kpi-grid').innerHTML = '<div class="empty" style="grid-column:1/-1;padding:40px">사이드바에서 광고주를 선택해주세요.</div>';
    }

    // ── 요약 탭 ──
    async function loadSummary() {
      const grid = document.getElementById('kpi-grid');
      grid.innerHTML = ${JSON.stringify(
        ['노출수','클릭수','CTR','총비용','구매완료전환매출','ROAS','평균순위','구매완료전환수'].map(l =>
          `<div class="kpi-card"><div class="kpi-label">${l}</div><div class="kpi-value"><span class="spinner"></span></div></div>`
        ).join('')
      )};
      try {
        const res = await fetch('/smart-sa/api/stats?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        renderKpi(json.stats);
      } catch(e) { toast('조회 실패: '+e.message, true); }
    }

    function renderKpi(s) {
      const roas = s?.roas || 0;
      const cards = [
        {l:'노출수', v:num(s?.impCnt)},
        {l:'클릭수', v:num(s?.clkCnt)},
        {l:'CTR',    v:pct(s?.ctr)},
        {l:'총비용', v:won(s?.salesAmt)},
        {l:'구매완료전환매출',v:won(s?.purchaseAmt)},
        {l:'ROAS',   v:roas+'%'},
        {l:'평균순위',v:rnk(s?.avgRnk)},
        {l:'구매완료전환수', v:num(s?.purchaseCnt)},
      ];
      document.getElementById('kpi-grid').innerHTML = cards.map(c =>
        '<div class="kpi-card"><div class="kpi-label">'+c.l+'</div><div class="kpi-value">'+c.v+'</div></div>'
      ).join('');
      if (s?.campStats?.length) renderChart(s.campStats);
    }

    function renderChart(campStats) {
      const chartWrap = document.getElementById('chart-wrap');
      const chartBody = document.getElementById('chart-body');
      if (!chartWrap || !chartBody) return;
      chartWrap.style.display = 'block';
      const maxCost = Math.max(...campStats.map(c => c.salesAmt || 0), 1);
      const maxPurchase = Math.max(...campStats.map(c => c.purchaseAmt || 0), 1);
      let html = '<div style="display:flex;gap:20px;flex-wrap:wrap">';
      html += '<div style="flex:1;min-width:300px">';
      campStats.forEach(c => {
        const costW = Math.max((c.salesAmt||0)/maxCost*100, 2);
        const purchW = maxPurchase > 0 ? Math.max((c.purchaseAmt||0)/maxPurchase*100, 2) : 2;
        html += '<div style="margin-bottom:10px"><div style="font-size:12px;font-weight:500;margin-bottom:3px;color:#374151">'+c.name+'</div>';
        html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px"><span style="font-size:10px;color:#94a3b8;width:60px">총비용</span><div style="flex:1;background:#fee2e2;border-radius:4px;height:16px;overflow:hidden"><div style="width:'+costW+'%;background:#ef4444;height:100%;border-radius:4px;min-width:2px"></div></div><span style="font-size:11px;font-weight:500;width:80px;text-align:right">'+won(c.salesAmt)+'</span></div>';
        html += '<div style="display:flex;align-items:center;gap:6px"><span style="font-size:10px;color:#94a3b8;width:60px">구매매출</span><div style="flex:1;background:#d1fae5;border-radius:4px;height:16px;overflow:hidden"><div style="width:'+purchW+'%;background:#10b981;height:100%;border-radius:4px;min-width:2px"></div></div><span style="font-size:11px;font-weight:500;width:80px;text-align:right">'+won(c.purchaseAmt)+'</span></div>';
        html += '</div>';
      });
      html += '</div>';
      html += '<div style="flex:1;min-width:280px"><h4 style="font-size:13px;font-weight:600;margin-bottom:12px;color:#374151">캠페인별 주요 지표</h4>';
      html += '<table style="width:100%;font-size:12px"><thead><tr><th style="text-align:left">캠페인</th><th style="text-align:right">클릭</th><th style="text-align:right">총비용</th><th style="text-align:right">구매매출</th><th style="text-align:right">ROAS</th></tr></thead><tbody>';
      campStats.forEach(c => {
        const roas = c.salesAmt > 0 ? Math.round((c.purchaseAmt||0)/c.salesAmt*100) : 0;
        html += '<tr><td>'+c.name+'</td><td style="text-align:right">'+num(c.clkCnt)+'</td><td style="text-align:right">'+won(c.salesAmt)+'</td><td style="text-align:right;color:#16a34a">'+won(c.purchaseAmt)+'</td><td style="text-align:right;color:'+(roas>=100?'#16a34a':'#ef4444')+'">'+roas+'%</td></tr>';
      });
      html += '</tbody></table></div></div>';
      chartBody.innerHTML = html;
    }

    // ── 키워드별 탭 ──
    let kwShowAll = { powerlink: false, shopping: false };
    let kwData = null;

    async function loadKeywords(showAll) {
      const wrap = document.getElementById('kw-tab-content');
      if (!kwData || showAll === undefined) {
        wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 키워드 데이터 로딩 중... (10~30초 소요)</div>';
        try {
          const lim = (showAll === 'powerlink' || showAll === 'shopping') ? 'all' : '10';
          const res = await fetch('/smart-sa/api/tab/keywords?'+periodParams()+'&limit='+lim);
          const json = await res.json();
          if (!json.ok) throw new Error(json.error);
          kwData = json;
          tabLoaded.keywords = true;
        } catch(e) { wrap.innerHTML = '<div class="empty">키워드 조회 실패: '+e.message+'</div>'; return; }
      }
      renderKeywordTab(kwData);
    }

    function renderKeywordTab(d) {
      const wrap = document.getElementById('kw-tab-content');
      let html = '';
      // 파워링크
      html += kwSection('파워링크', d.powerlink, d.powerlinkTotal, 'powerlink');
      // 쇼핑검색
      html += kwSection('쇼핑검색', d.shopping, d.shoppingTotal, 'shopping');
      if (d.other?.length) html += kwSection('기타', d.other, d.otherTotal, 'other');
      wrap.innerHTML = html;
    }

    function kwSection(title, items, total, type) {
      if (!items?.length) return '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">'+title+'</span></div><div class="card-body"><div class="empty">데이터 없음</div></div></div>';
      let html = '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">'+title+'</span><span style="font-size:12px;color:#94a3b8">총 '+total+'개 키워드</span></div><div class="card-body" style="overflow-x:auto">';
      html += '<table style="table-layout:auto"><thead><tr><th style="width:30px">#</th><th style="min-width:140px">키워드</th><th style="text-align:right">노출</th><th style="text-align:right">클릭</th><th style="text-align:right">CTR</th><th style="text-align:right">총비용</th><th style="text-align:right">CPC</th><th style="text-align:right">구매전환수</th><th style="text-align:right">구매전환매출</th><th style="text-align:right">ROAS</th></tr></thead><tbody>';
      items.forEach((kw,i) => {
        html += '<tr><td style="color:#94a3b8;text-align:center">'+(i+1)+'</td>';
        html += '<td style="white-space:nowrap"><strong>'+kw.keyword+'</strong><br><span style="font-size:11px;color:#94a3b8">'+kw.campaignName+'</span></td>';
        html += '<td style="text-align:right;white-space:nowrap">'+num(kw.imp)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+num(kw.clk)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap">'+pct(kw.ctr)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap">'+won(kw.cost)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap">'+won(kw.cpc)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+num(kw.purchaseCnt)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+won(kw.purchaseAmt)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;font-weight:600;color:'+(kw.roas>=100?'#16a34a':'#ef4444')+'">'+kw.roas+'%</td>';
        html += '</tr>';
      });
      html += '</tbody></table>';
      if (items.length < total) {
        html += '<div style="text-align:center;padding:12px"><button class="btn btn-outline" onclick="loadAllKeywords(\\\''+type+'\\\')">더보기 (전체 '+total+'개)</button></div>';
      }
      html += '</div></div>';
      return html;
    }

    async function loadAllKeywords(type) {
      tabLoaded.keywords = false;
      kwData = null;
      const wrap = document.getElementById('kw-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 전체 키워드 로딩 중...</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/keywords?'+periodParams()+'&limit=all');
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        kwData = json;
        tabLoaded.keywords = true;
        renderKeywordTab(kwData);
      } catch(e) { wrap.innerHTML = '<div class="empty">오류: '+e.message+'</div>'; }
    }

    // ── 시간대별 탭 ──
    async function loadHourly() {
      const wrap = document.getElementById('hourly-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 시간대별 데이터 로딩 중... (10~30초 소요)</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/hourly?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        tabLoaded.hourly = true;
        renderHourlyTab(json);
      } catch(e) { wrap.innerHTML = '<div class="empty">시간대별 조회 실패: '+e.message+'</div>'; }
    }

    function renderHourlyTab(d) {
      const wrap = document.getElementById('hourly-tab-content');
      let html = '';
      // 시간대별 히트맵
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">시간대별 성과</span></div><div class="card-body" style="overflow-x:auto">';
      const maxCost = Math.max(...d.byHour.map(h => h.cost), 1);
      html += '<table><thead><tr><th>시간</th><th style="text-align:right">노출</th><th style="text-align:right">클릭</th><th style="text-align:right">CTR</th><th style="text-align:right">총비용</th><th style="text-align:right">CPC</th><th style="text-align:right">구매전환</th><th style="text-align:right">구매매출</th><th style="text-align:right">ROAS</th><th style="width:120px">비용비중</th></tr></thead><tbody>';
      d.byHour.forEach(h => {
        const barW = Math.max((h.cost/maxCost)*100, 1);
        html += '<tr><td style="font-weight:600">'+String(h.hour).padStart(2,'0')+':00</td>';
        html += '<td style="text-align:right">'+num(h.imp)+'</td>';
        html += '<td style="text-align:right;color:#2563eb">'+num(h.clk)+'</td>';
        html += '<td style="text-align:right">'+pct(h.ctr)+'</td>';
        html += '<td style="text-align:right">'+won(h.cost)+'</td>';
        html += '<td style="text-align:right">'+won(h.cpc)+'</td>';
        html += '<td style="text-align:right;color:#7c3aed">'+num(h.purchaseCnt)+'</td>';
        html += '<td style="text-align:right;color:#16a34a">'+won(h.purchaseAmt)+'</td>';
        html += '<td style="text-align:right;font-weight:600;color:'+(h.roas>=100?'#16a34a':'#ef4444')+'">'+h.roas+'%</td>';
        html += '<td><div style="background:#e2e8f0;border-radius:4px;height:14px;overflow:hidden"><div style="width:'+barW+'%;background:#3b82f6;height:100%;border-radius:4px"></div></div></td>';
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';

      // 요일별
      html += '<div class="card"><div class="card-header"><span class="card-title">요일별 성과</span></div><div class="card-body" style="overflow-x:auto">';
      const maxDayCost = Math.max(...d.byDay.map(d2 => d2.cost), 1);
      html += '<table><thead><tr><th>요일</th><th style="text-align:right">노출</th><th style="text-align:right">클릭</th><th style="text-align:right">CTR</th><th style="text-align:right">총비용</th><th style="text-align:right">CPC</th><th style="text-align:right">구매전환</th><th style="text-align:right">구매매출</th><th style="text-align:right">ROAS</th><th style="width:120px">비용비중</th></tr></thead><tbody>';
      d.byDay.forEach(day => {
        const barW = Math.max((day.cost/maxDayCost)*100, 1);
        html += '<tr><td style="font-weight:600">'+day.day+'요일</td>';
        html += '<td style="text-align:right">'+num(day.imp)+'</td>';
        html += '<td style="text-align:right;color:#2563eb">'+num(day.clk)+'</td>';
        html += '<td style="text-align:right">'+pct(day.ctr)+'</td>';
        html += '<td style="text-align:right">'+won(day.cost)+'</td>';
        html += '<td style="text-align:right">'+won(day.cpc)+'</td>';
        html += '<td style="text-align:right;color:#7c3aed">'+num(day.purchaseCnt)+'</td>';
        html += '<td style="text-align:right;color:#16a34a">'+won(day.purchaseAmt)+'</td>';
        html += '<td style="text-align:right;font-weight:600;color:'+(day.roas>=100?'#16a34a':'#ef4444')+'">'+day.roas+'%</td>';
        html += '<td><div style="background:#e2e8f0;border-radius:4px;height:14px;overflow:hidden"><div style="width:'+barW+'%;background:#f59e0b;height:100%;border-radius:4px"></div></div></td>';
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
      wrap.innerHTML = html;
    }

    // ── 타겟별 탭 ──
    async function loadDevice() {
      const wrap = document.getElementById('target-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 타겟별 데이터 로딩 중... (10~30초 소요)</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/device?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        tabLoaded.target = true;
        renderDeviceTab(json);
      } catch(e) { wrap.innerHTML = '<div class="empty">타겟별 조회 실패: '+e.message+'</div>'; }
    }

    function renderDeviceTab(d) {
      const wrap = document.getElementById('target-tab-content');
      const total = { imp: d.pc.imp+d.mobile.imp, clk: d.pc.clk+d.mobile.clk, cost: d.pc.cost+d.mobile.cost };
      function devCard(label, icon, data, color) {
        const costShare = total.cost > 0 ? (data.cost/total.cost*100).toFixed(1) : 0;
        const clkShare = total.clk > 0 ? (data.clk/total.clk*100).toFixed(1) : 0;
        return '<div class="card" style="flex:1;min-width:280px"><div class="card-header"><span class="card-title">'+icon+' '+label+'</span><span class="badge" style="background:'+color+'20;color:'+color+'">비용 '+costShare+'%</span></div><div class="card-body">'
          +'<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
          +'<div><div style="font-size:11px;color:#94a3b8">노출수</div><div style="font-size:18px;font-weight:700">'+num(data.imp)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">클릭수</div><div style="font-size:18px;font-weight:700;color:#2563eb">'+num(data.clk)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">CTR</div><div style="font-size:18px;font-weight:700">'+pct(data.ctr)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">총비용</div><div style="font-size:18px;font-weight:700">'+won(data.cost)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">CPC</div><div style="font-size:18px;font-weight:700">'+won(data.cpc)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">구매전환수</div><div style="font-size:18px;font-weight:700;color:#7c3aed">'+num(data.purchaseCnt)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">구매전환매출</div><div style="font-size:18px;font-weight:700;color:#16a34a">'+won(data.purchaseAmt)+'</div></div>'
          +'<div><div style="font-size:11px;color:#94a3b8">ROAS</div><div style="font-size:18px;font-weight:700;color:'+(data.roas>=100?'#16a34a':'#ef4444')+'">'+data.roas+'%</div></div>'
          +'</div></div></div>';
      }
      let html = '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">';
      html += devCard('PC', '🖥', d.pc, '#3b82f6');
      html += devCard('모바일', '📱', d.mobile, '#f59e0b');
      html += '</div>';

      // PC vs MO 비교 바
      html += '<div class="card" style="margin-bottom:16px"><div class="card-header"><span class="card-title">PC vs 모바일 비교</span></div><div class="card-body">';
      ['비용','클릭','노출','구매매출'].forEach(metric => {
        const pcV = metric==='비용'?d.pc.cost:metric==='클릭'?d.pc.clk:metric==='노출'?d.pc.imp:d.pc.purchaseAmt;
        const moV = metric==='비용'?d.mobile.cost:metric==='클릭'?d.mobile.clk:metric==='노출'?d.mobile.imp:d.mobile.purchaseAmt;
        const t = pcV+moV||1;
        const pcPct = (pcV/t*100).toFixed(0);
        const moPct = (moV/t*100).toFixed(0);
        html += '<div style="margin-bottom:12px"><div style="font-size:12px;font-weight:600;margin-bottom:4px">'+metric+'</div>';
        html += '<div style="display:flex;height:22px;border-radius:6px;overflow:hidden">';
        html += '<div style="width:'+pcPct+'%;background:#3b82f6;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;min-width:30px">PC '+pcPct+'%</div>';
        html += '<div style="width:'+moPct+'%;background:#f59e0b;display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600;min-width:30px">MO '+moPct+'%</div>';
        html += '</div></div>';
      });
      html += '</div></div>';

      html += '<div class="card"><div class="card-body" style="text-align:center;padding:24px;color:#94a3b8;font-size:13px">연령대/성별 데이터는 네이버 검색광고 API에서 제공하지 않습니다.<br>네이버 광고 관리 시스템에서 직접 확인해주세요.</div></div>';
      wrap.innerHTML = html;
    }

    // ── 그룹별 탭 ──
    async function loadAdgroups() {
      const wrap = document.getElementById('adgroups-tab-content');
      wrap.innerHTML = '<div class="empty"><span class="spinner"></span> 광고그룹 데이터 로딩 중... (10~30초 소요)</div>';
      try {
        const res = await fetch('/smart-sa/api/tab/adgroups?'+periodParams());
        const json = await res.json();
        if (!json.ok) throw new Error(json.error);
        tabLoaded.adgroups = true;
        renderAdgroupTab(json.adgroups);
      } catch(e) { wrap.innerHTML = '<div class="empty">광고그룹 조회 실패: '+e.message+'</div>'; }
    }

    function renderAdgroupTab(adgroups) {
      const wrap = document.getElementById('adgroups-tab-content');
      if (!adgroups?.length) { wrap.innerHTML = '<div class="empty">광고그룹 데이터가 없습니다.</div>'; return; }
      let html = '<div class="card"><div class="card-header"><span class="card-title">광고그룹별 성과</span><span style="font-size:12px;color:#94a3b8">'+adgroups.length+'개 그룹</span></div><div class="card-body" style="overflow-x:auto">';
      html += '<table style="table-layout:auto"><thead><tr><th style="width:30px">#</th><th style="white-space:nowrap">광고그룹</th><th style="white-space:nowrap">캠페인</th><th style="text-align:right;white-space:nowrap">노출</th><th style="text-align:right;white-space:nowrap">클릭</th><th style="text-align:right;white-space:nowrap">CTR</th><th style="text-align:right;white-space:nowrap">총비용</th><th style="text-align:right;white-space:nowrap">CPC</th><th style="text-align:right;white-space:nowrap">구매전환</th><th style="text-align:right;white-space:nowrap">구매매출</th><th style="text-align:right;white-space:nowrap">ROAS</th></tr></thead><tbody>';
      adgroups.forEach((ag,i) => {
        const tpBadge = ag.campaignTp===2?'<span class="badge badge-blue" style="margin-left:4px;font-size:10px">쇼핑</span>':'';
        html += '<tr><td style="color:#94a3b8;text-align:center">'+(i+1)+'</td>';
        html += '<td style="white-space:nowrap"><strong>'+ag.adgroupName+'</strong></td>';
        html += '<td style="white-space:nowrap">'+ag.campaignName+tpBadge+'</td>';
        html += '<td style="text-align:right;white-space:nowrap">'+num(ag.imp)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;color:#2563eb;font-weight:600">'+num(ag.clk)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap">'+pct(ag.ctr)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap">'+won(ag.cost)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap">'+won(ag.cpc)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;color:#7c3aed;font-weight:600">'+num(ag.purchaseCnt)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;color:#16a34a;font-weight:600">'+won(ag.purchaseAmt)+'</td>';
        html += '<td style="text-align:right;white-space:nowrap;font-weight:600;color:'+(ag.roas>=100?'#16a34a':'#ef4444')+'">'+ag.roas+'%</td>';
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
      wrap.innerHTML = html;
    }

    // ── 공통 유틸 ──
    function num(v){return Number(v||0).toLocaleString('ko-KR')}
    function pct(v){return Number(v||0).toFixed(2)+'%'}
    function won(v){return '₩'+Number(v||0).toLocaleString('ko-KR')}
    function rnk(v){return v?Number(v).toFixed(1)+'위':'-'}
    </script>
  `;

  res.send(appLayout('성과 대시보드', content, user, 'dashboard', await getLayoutOpts(req)));
});

// ─── API: 통계 ──────────────────────────────────────────────────────
router.get('/api/stats', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    if (!accountId) return res.status(400).json({ ok: false, error: '광고주를 선택해주세요.' });

    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주를 찾을 수 없습니다' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);

    // DB 동기화 데이터 우선 조회 (빠른 경로)
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const stats = await db.queryStatsSummary(account.id, dateRange.since, dateRange.until);
      return res.json({ ok: true, stats, source: 'db' });
    }

    // Fallback: 실시간 API 호출
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);

    const [statsResult, convResult] = await Promise.allSettled([
      client.getStats({ startDate: dateRange.since, endDate: dateRange.until }),
      fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange),
    ]);

    const stats = statsResult.status === 'fulfilled' ? statsResult.value
      : { impCnt: 0, clkCnt: 0, salesAmt: 0, ctr: 0, avgRnk: 0 };

    if (convResult.status === 'fulfilled') {
      const convRows = convResult.value;
      let purchaseAmt = 0, purchaseCnt = 0;
      const byCampaign = {};
      for (const { cols } of convRows) {
        if (cols.length < 15) continue;
        const convType = cols[12];
        if (convType === 'purchase' || convType === 'purchase_complete' || convType === 'complete_purchase') {
          const campaignId = cols[2];
          const cnt = parseInt(cols[13]) || 0;
          const amt = parseInt(cols[14]) || 0;
          purchaseAmt += amt;
          purchaseCnt += cnt;
          if (!byCampaign[campaignId]) byCampaign[campaignId] = { amt: 0, cnt: 0 };
          byCampaign[campaignId].amt += amt;
          byCampaign[campaignId].cnt += cnt;
        }
      }
      stats.purchaseAmt = purchaseAmt;
      stats.purchaseCnt = purchaseCnt;
      stats.roas = stats.salesAmt > 0 ? Math.round(purchaseAmt / stats.salesAmt * 100) : 0;
      if (stats.campStats) {
        for (const cs of stats.campStats) {
          const p = byCampaign[cs.id] || { amt: 0, cnt: 0 };
          cs.purchaseAmt = p.amt;
          cs.purchaseCnt = p.cnt;
        }
      }
    }

    res.json({ ok: true, stats, source: 'api' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 키워드별 통계 (별도 로딩) ─────────────────────────────────
router.get('/api/keyword-stats', requireLogin, async (req, res) => {
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

    const keywordStats = await client.getKeywordStats({ timeRange });
    res.json({ ok: true, keywordStats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── Stat Report 캐시 레이어 ─────────────────────────────────────────
const statCache = new Map(); // key: "customerId:reportTp:date" → parsed rows
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4시간

function getCacheKey(customerId, reportTp, dt) { return `${customerId}:${reportTp}:${dt}`; }

async function cachedStatReport(client, customerId, reportTp, dt) {
  const key = getCacheKey(customerId, reportTp, dt);
  const cached = statCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.rows;
  const rows = await client.createAndDownloadStatReport(reportTp, dt);
  statCache.set(key, { rows, ts: Date.now() });
  // LRU: 500개 초과 시 오래된 것 제거
  if (statCache.size > 500) {
    const oldest = [...statCache.entries()].sort((a,b) => a[1].ts - b[1].ts)[0];
    if (oldest) statCache.delete(oldest[0]);
  }
  return rows;
}

function getDatesBetween(since, until) {
  const dates = [];
  const s = new Date(since), e = new Date(until);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) dates.push(d.toISOString().slice(0, 10));
  return dates;
}

// KST(UTC+9) 기준 날짜 포맷
function fmtKST(d) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function resolvePeriodDates(period, startDate, endDate) {
  if (period === 'custom' && startDate && endDate) {
    return { since: startDate, until: endDate };
  }
  const now = new Date();
  if (period === '7days') {
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return { since: fmtKST(start), until: fmtKST(end) };
  }
  if (period === '30days') {
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 30);
    return { since: fmtKST(start), until: fmtKST(end) };
  }
  const d = new Date(now); d.setDate(d.getDate() - 1);
  return { since: fmtKST(d), until: fmtKST(d) };
}

async function fetchAllStatRows(client, customerId, reportTp, dateRange) {
  const dates = getDatesBetween(dateRange.since, dateRange.until);
  const allRows = [];
  // 동시 10개씩 병렬 다운로드
  for (let i = 0; i < dates.length; i += 10) {
    const batch = dates.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map(dt => cachedStatReport(client, customerId, reportTp, dt).then(rows => rows.map(r => ({ date: dt, cols: r }))))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') allRows.push(...r.value);
    }
  }
  return allRows;
}

// 마스터 데이터 없을 때 API에서 이름 매핑 빌드
// Naver API campaignTp: 정수 또는 문자열 모두 처리
function normalizeCampaignTp(tp) {
  if (tp === 1 || tp === '1' || tp === 'WEB_SITE') return 1;
  if (tp === 2 || tp === '2' || tp === 'SHOPPING') return 2;
  if (tp === 4 || tp === '4' || tp === 'BRAND') return 4;
  return parseInt(tp) || 1;
}

// 이름 매핑 캐시 (5분 TTL)
const nameMapCache = new Map();
const NAME_MAP_TTL = 5 * 60 * 1000;

async function buildNameMapsFromApi(client) {
  const campMap = {}, agMap = {}, kwMap = {};
  try {
    const campaigns = await client.getCampaigns();
    for (const c of (campaigns || [])) {
      campMap[c.nccCampaignId] = { name: c.name, tp: normalizeCampaignTp(c.campaignTp) };
    }

    // 모든 캠페인의 광고그룹을 병렬 조회
    const agResults = await Promise.allSettled(
      (campaigns || []).map(c => client.getAdGroups(c.nccCampaignId).then(ags => ({ campaignId: c.nccCampaignId, ags })))
    );
    const allAdgroups = [];
    for (const r of agResults) {
      if (r.status !== 'fulfilled') continue;
      const { campaignId, ags } = r.value;
      for (const ag of (ags || [])) {
        agMap[ag.nccAdgroupId] = { name: ag.name, campaignId };
        allAdgroups.push({ ag, campaignId });
      }
    }

    // 모든 광고그룹의 키워드를 병렬 조회 (10개씩 배치)
    for (let i = 0; i < allAdgroups.length; i += 10) {
      const batch = allAdgroups.slice(i, i + 10);
      const kwResults = await Promise.allSettled(
        batch.map(({ ag, campaignId }) => client.getKeywords(ag.nccAdgroupId).then(kws => ({ ag, campaignId, kws })))
      );
      for (const r of kwResults) {
        if (r.status !== 'fulfilled') continue;
        const { ag, campaignId, kws } = r.value;
        for (const kw of (kws || [])) {
          kwMap[kw.nccKeywordId] = {
            keyword: kw.keyword, adgroupId: ag.nccAdgroupId,
            adgroupName: ag.name, campaignId,
            campaignName: campMap[campaignId]?.name || '',
            campaignTp: campMap[campaignId]?.tp || 1,
          };
        }
      }
    }
  } catch (e) {}
  return { campMap, agMap, kwMap };
}

async function getNameMaps(client, accountId) {
  // 캐시 확인
  const cacheKey = `nm:${accountId}`;
  const cached = nameMapCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NAME_MAP_TTL) return cached.data;

  const master = await db.buildKeywordMaps(accountId);
  const hasMaster = Object.keys(master.kwMap).length > 0;
  if (hasMaster) {
    const data = { ...master, hasMaster: true };
    nameMapCache.set(cacheKey, { data, ts: Date.now() });
    return data;
  }
  const api = await buildNameMapsFromApi(client);
  const data = { ...api, hasMaster: false };
  nameMapCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── API: 탭 데이터 (키워드별) ──────────────────────────────────────
router.get('/api/tab/keywords', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId, limit: lim } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);

    // DB 동기화 데이터 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const rows = await db.queryStatsKeywords(account.id, dateRange.since, dateRange.until);
      // 쇼핑검색은 adgroupId 기준으로 재집계
      const byKw = {};
      for (const r of rows) {
        const campTp = normalizeCampaignTp(r.campaignTp);
        const groupKey = (campTp === 2) ? `ag:${r.adgroup_id}` : `kw:${r.keyword_id}`;
        if (!byKw[groupKey]) {
          byKw[groupKey] = {
            keywordId: campTp === 2 ? r.adgroup_id : r.keyword_id,
            keyword: campTp === 2 ? r.adgroupName : r.keyword,
            campaignTp: campTp,
            campaignName: r.campaignName,
            adgroupName: r.adgroupName,
            imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0,
          };
        }
        byKw[groupKey].imp += r.imp;
        byKw[groupKey].clk += r.clk;
        byKw[groupKey].cost += Number(r.cost);
        byKw[groupKey].purchaseCnt += r.purchaseCnt;
        byKw[groupKey].purchaseAmt += Number(r.purchaseAmt);
      }

      const allKw = Object.values(byKw).map(kw => ({
        ...kw,
        ctr: kw.imp > 0 ? (kw.clk / kw.imp * 100) : 0,
        cpc: kw.clk > 0 ? Math.round(kw.cost / kw.clk) : 0,
        roas: kw.cost > 0 ? Math.round(kw.purchaseAmt / kw.cost * 100) : 0,
      }));

      const powerlink = allKw.filter(k => k.campaignTp === 1).sort((a, b) => b.cost - a.cost);
      const shopping = allKw.filter(k => k.campaignTp === 2).sort((a, b) => b.cost - a.cost);
      const other = allKw.filter(k => k.campaignTp !== 1 && k.campaignTp !== 2).sort((a, b) => b.cost - a.cost);
      const maxItems = lim === 'all' ? 99999 : 10;
      return res.json({
        ok: true, hasMaster: true, source: 'db',
        powerlink: powerlink.slice(0, maxItems), shopping: shopping.slice(0, maxItems), other: other.slice(0, maxItems),
        powerlinkTotal: powerlink.length, shoppingTotal: shopping.length, otherTotal: other.length,
      });
    }

    // Fallback: API 실시간 호출
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);

    const { kwMap, agMap, campMap, hasMaster } = await getNameMaps(client, account.id);

    const adRows = await fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange);
    const convRows = await fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange);

    const byKw = {};
    for (const { cols } of adRows) {
      if (cols.length < 14) continue;
      const campId = cols[2]; const agId = cols[3]; const kwId = cols[4];
      const campTp = normalizeCampaignTp(campMap[campId]?.tp || kwMap[kwId]?.campaignTp || 0);
      const groupKey = (campTp === 2) ? `ag:${agId}` : `kw:${kwId}`;
      if (!byKw[groupKey]) {
        if (campTp === 2) {
          const agInfo = agMap[agId] || {};
          byKw[groupKey] = { keywordId: agId, keyword: agInfo.name || agId, campaignTp: 2, campaignName: campMap[campId]?.name || '', adgroupName: agInfo.name || '', imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
        } else {
          const info = kwMap[kwId] || {};
          byKw[groupKey] = { keywordId: kwId, keyword: info.keyword || kwId, campaignTp: campTp, campaignName: info.campaignName || campMap[campId]?.name || '', adgroupName: info.adgroupName || '', imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
        }
      }
      byKw[groupKey].imp += parseInt(cols[11]) || 0;
      byKw[groupKey].clk += parseInt(cols[12]) || 0;
      byKw[groupKey].cost += parseInt(cols[13]) || 0;
    }
    for (const { cols } of convRows) {
      if (cols.length < 15) continue;
      const campId = cols[2]; const agId = cols[3]; const kwId = cols[4]; const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const campTp = normalizeCampaignTp(campMap[campId]?.tp || kwMap[kwId]?.campaignTp || 0);
      const groupKey = (campTp === 2) ? `ag:${agId}` : `kw:${kwId}`;
      if (!byKw[groupKey]) continue;
      byKw[groupKey].purchaseCnt += parseInt(cols[13]) || 0;
      byKw[groupKey].purchaseAmt += parseInt(cols[14]) || 0;
    }

    const allKw = Object.values(byKw).map(kw => ({ ...kw, ctr: kw.imp > 0 ? (kw.clk / kw.imp * 100) : 0, cpc: kw.clk > 0 ? Math.round(kw.cost / kw.clk) : 0, roas: kw.cost > 0 ? Math.round(kw.purchaseAmt / kw.cost * 100) : 0 }));
    const powerlink = allKw.filter(k => k.campaignTp === 1).sort((a, b) => b.cost - a.cost);
    const shopping = allKw.filter(k => k.campaignTp === 2).sort((a, b) => b.cost - a.cost);
    const other = allKw.filter(k => k.campaignTp !== 1 && k.campaignTp !== 2).sort((a, b) => b.cost - a.cost);
    const maxItems = lim === 'all' ? 99999 : 10;
    res.json({ ok: true, hasMaster, source: 'api', powerlink: powerlink.slice(0, maxItems), shopping: shopping.slice(0, maxItems), other: other.slice(0, maxItems), powerlinkTotal: powerlink.length, shoppingTotal: shopping.length, otherTotal: other.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (시간대별) ──────────────────────────────────────
router.get('/api/tab/hourly', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const enrich = obj => ({
      ...obj, cost: Number(obj.cost || 0), purchaseAmt: Number(obj.purchaseAmt || 0),
      ctr: obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0,
      cpc: obj.clk > 0 ? Math.round(Number(obj.cost) / obj.clk) : 0,
      roas: Number(obj.cost) > 0 ? Math.round(Number(obj.purchaseAmt) / Number(obj.cost) * 100) : 0,
    });

    // DB 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const { byHour: dbHour, byDay: dbDay } = await db.queryStatsHourly(account.id, dateRange.since, dateRange.until);
      // 시간대 0~23 전체 채우기
      const hourMap = {};
      for (let h = 0; h < 24; h++) hourMap[h] = { hour: h, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
      for (const r of dbHour) hourMap[r.hour] = { hour: r.hour, imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt };

      const dayNames = ['일','월','화','수','목','금','토'];
      const dayMap = {};
      for (let d = 0; d < 7; d++) dayMap[d] = { day: dayNames[d], dayIdx: d, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
      for (const r of dbDay) dayMap[r.dow] = { day: dayNames[r.dow], dayIdx: r.dow, imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt };

      return res.json({
        ok: true, source: 'db',
        byHour: Object.values(hourMap).map(enrich),
        byDay: [1,2,3,4,5,6,0].map(d => enrich(dayMap[d])),
      });
    }

    // Fallback: API
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });
    const client = makeClient(creds, account.customer_id);

    const adRows = await fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange);
    const convRows = await fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange);

    const byHour = {};
    for (let h = 0; h < 24; h++) byHour[h] = { hour: h, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
    const dayNames = ['일','월','화','수','목','금','토'];
    const byDay = {};
    for (let d = 0; d < 7; d++) byDay[d] = { day: dayNames[d], dayIdx: d, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };

    for (const { date, cols } of adRows) {
      if (cols.length < 14) continue;
      const hour = parseInt(cols[7]) || 0;
      byHour[hour].imp += parseInt(cols[11]) || 0;
      byHour[hour].clk += parseInt(cols[12]) || 0;
      byHour[hour].cost += parseInt(cols[13]) || 0;
      const dow = new Date(date).getDay();
      byDay[dow].imp += parseInt(cols[11]) || 0;
      byDay[dow].clk += parseInt(cols[12]) || 0;
      byDay[dow].cost += parseInt(cols[13]) || 0;
    }
    for (const { date, cols } of convRows) {
      if (cols.length < 15) continue;
      const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const hour = parseInt(cols[7]) || 0;
      byHour[hour].purchaseCnt += parseInt(cols[13]) || 0;
      byHour[hour].purchaseAmt += parseInt(cols[14]) || 0;
      const dow = new Date(date).getDay();
      byDay[dow].purchaseCnt += parseInt(cols[13]) || 0;
      byDay[dow].purchaseAmt += parseInt(cols[14]) || 0;
    }

    res.json({ ok: true, source: 'api', byHour: Object.values(byHour).map(enrich), byDay: [1,2,3,4,5,6,0].map(d => enrich(byDay[d])) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (타겟별 - PC/MO) ───────────────────────────────
router.get('/api/tab/device', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const enrich = obj => ({
      ...obj, cost: Number(obj.cost || 0), purchaseAmt: Number(obj.purchaseAmt || 0),
      ctr: obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0,
      cpc: obj.clk > 0 ? Math.round(Number(obj.cost) / obj.clk) : 0,
      roas: Number(obj.cost) > 0 ? Math.round(Number(obj.purchaseAmt) / Number(obj.cost) * 100) : 0,
    });

    // DB 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const rows = await db.queryStatsDevice(account.id, dateRange.since, dateRange.until);
      const byDev = { PC: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 }, MO: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 } };
      for (const r of rows) byDev[r.device] = { imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt };
      return res.json({ ok: true, source: 'db', pc: enrich(byDev.PC), mobile: enrich(byDev.MO) });
    }

    // Fallback: API
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });
    const client = makeClient(creds, account.customer_id);

    const adRows = await fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange);
    const convRows = await fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange);

    const byDevice = { PC: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 }, MO: { imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 } };
    for (const { cols } of adRows) {
      if (cols.length < 14) continue;
      const dev = cols[10] === 'P' ? 'PC' : 'MO';
      byDevice[dev].imp += parseInt(cols[11]) || 0;
      byDevice[dev].clk += parseInt(cols[12]) || 0;
      byDevice[dev].cost += parseInt(cols[13]) || 0;
    }
    for (const { cols } of convRows) {
      if (cols.length < 15) continue;
      const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const dev = cols[10] === 'P' ? 'PC' : 'MO';
      byDevice[dev].purchaseCnt += parseInt(cols[13]) || 0;
      byDevice[dev].purchaseAmt += parseInt(cols[14]) || 0;
    }

    res.json({ ok: true, source: 'api', pc: enrich(byDevice.PC), mobile: enrich(byDevice.MO) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── API: 탭 데이터 (그룹별) ────────────────────────────────────────
router.get('/api/tab/adgroups', requireLogin, async (req, res) => {
  try {
    const { period = 'yesterday', accountId } = req.query;
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });

    const dateRange = resolvePeriodDates(period, req.query.startDate, req.query.endDate);
    const enrich = obj => ({
      ...obj, cost: Number(obj.cost || 0), purchaseAmt: Number(obj.purchaseAmt || 0),
      ctr: obj.imp > 0 ? (obj.clk / obj.imp * 100) : 0,
      cpc: obj.clk > 0 ? Math.round(Number(obj.cost) / obj.clk) : 0,
      roas: Number(obj.cost) > 0 ? Math.round(Number(obj.purchaseAmt) / Number(obj.cost) * 100) : 0,
    });

    // DB 우선 조회
    const synced = await db.isSynced(account.id, dateRange.since, dateRange.until);
    if (synced) {
      const rows = await db.queryStatsAdgroups(account.id, dateRange.since, dateRange.until);
      const adgroups = rows.map(r => enrich({
        adgroupId: r.adgroup_id, adgroupName: r.adgroupName,
        campaignName: r.campaignName, campaignTp: r.campaignTp,
        imp: r.imp, clk: r.clk, cost: r.cost, purchaseCnt: r.purchaseCnt, purchaseAmt: r.purchaseAmt,
      })).sort((a, b) => {
        const cmp = (a.campaignName || '').localeCompare(b.campaignName || '');
        return cmp !== 0 ? cmp : (a.adgroupName || '').localeCompare(b.adgroupName || '');
      });
      return res.json({ ok: true, source: 'db', adgroups });
    }

    // Fallback: API
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });
    const client = makeClient(creds, account.customer_id);
    const { agMap, campMap } = await getNameMaps(client, account.id);

    const adRows = await fetchAllStatRows(client, account.customer_id, 'AD_DETAIL', dateRange);
    const convRows = await fetchAllStatRows(client, account.customer_id, 'AD_CONVERSION_DETAIL', dateRange);

    const byAg = {};
    for (const { cols } of adRows) {
      if (cols.length < 14) continue;
      const agId = cols[3]; const campId = cols[2];
      if (!byAg[agId]) {
        const info = agMap[agId] || {}; const camp = campMap[info.campaignId || campId] || {};
        byAg[agId] = { adgroupId: agId, adgroupName: info.name || agId, campaignName: camp.name || campId, campaignTp: camp.tp || 0, imp: 0, clk: 0, cost: 0, purchaseCnt: 0, purchaseAmt: 0 };
      }
      byAg[agId].imp += parseInt(cols[11]) || 0;
      byAg[agId].clk += parseInt(cols[12]) || 0;
      byAg[agId].cost += parseInt(cols[13]) || 0;
    }
    for (const { cols } of convRows) {
      if (cols.length < 15) continue;
      const convType = cols[12];
      if (convType !== 'purchase' && convType !== 'purchase_complete' && convType !== 'complete_purchase') continue;
      const agId = cols[3];
      if (!byAg[agId]) continue;
      byAg[agId].purchaseCnt += parseInt(cols[13]) || 0;
      byAg[agId].purchaseAmt += parseInt(cols[14]) || 0;
    }

    const adgroups = Object.values(byAg).map(enrich).sort((a, b) => {
      const cmp = (a.campaignName || '').localeCompare(b.campaignName || '');
      return cmp !== 0 ? cmp : (a.adgroupName || '').localeCompare(b.adgroupName || '');
    });
    res.json({ ok: true, source: 'api', adgroups });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ─── 키워드 순위 ────────────────────────────────────────────────────
// ─── 자동입찰 ──────────────────────────────────────────────────────
router.get('/autobid', requireLogin, requireApi, async (req, res) => {
  const user = await getUser(req);
  const accounts = await db.getAccountsByUser(user.id);
  const selectedId = req.query.accountId || accounts[0]?.id || '';

  const content = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:12px">
      <div>
        <p style="color:#64748b;font-size:13px;margin:0">키워드별 희망순위에 맞춰 입찰가를 자동으로 조정합니다.</p>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <select id="ab-account" style="width:200px" onchange="location.href='/smart-sa/autobid?accountId='+this.value">
          ${accounts.map(a => `<option value="${a.id}" ${a.id==selectedId?'selected':''}>${a.name}</option>`).join('')}
        </select>
        <button class="btn btn-primary" onclick="openAddModal()">+ 키워드 추가</button>
      </div>
    </div>

    <!-- 등록된 키워드 목록 -->
    <div class="card">
      <div class="card-header">
        <span class="card-title">🎯 자동 입찰 키워드 관리</span>
        <span id="ab-count" style="font-size:12px;color:#94a3b8"></span>
      </div>
      <div id="ab-list"><div class="empty"><span class="spinner"></span> 로딩 중...</div></div>
    </div>

    <!-- 키워드 추가 모달 -->
    <div id="add-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:none;align-items:center;justify-content:center">
      <div style="background:#fff;border-radius:12px;width:100%;max-width:640px;max-height:90vh;overflow-y:auto;padding:24px;margin:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
          <h3 style="margin:0;font-size:16px">키워드 추가</h3>
          <button onclick="closeAddModal()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8">&times;</button>
        </div>

        <div style="margin-bottom:16px">
          <button class="btn" onclick="loadKeywordList()" id="load-kw-btn" style="width:100%">📋 광고주 키워드 목록 불러오기</button>
          <div id="kw-search-wrap" style="display:none;margin-top:10px">
            <input id="kw-search" placeholder="키워드 검색..." style="width:100%;margin-bottom:8px" oninput="filterKwList()">
            <div id="kw-pick-list" style="max-height:200px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:8px"></div>
          </div>
        </div>

        <div class="form-group"><label>키워드</label><input id="add-keyword" readonly style="background:#f8fafc"></div>
        <input type="hidden" id="add-kwid">

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
          <div class="form-group"><label>지면</label>
            <select id="add-device"><option value="PC">PC</option><option value="MO" selected>MOBILE</option></select>
          </div>
          <div class="form-group"><label>희망순위</label><input id="add-rank" type="number" value="3" min="1" max="15"></div>
          <div class="form-group"><label>최대입찰가 (원)</label><input id="add-maxbid" type="number" value="5000" step="100"></div>
          <div class="form-group"><label>조정입찰가 (원)</label><input id="add-adjust" type="number" value="100" step="10"></div>
        </div>

        <div class="form-group">
          <label>실행 시간대 <span style="font-size:11px;color:#94a3b8">(클릭하여 ON/OFF)</span></label>
          <div id="add-schedule" style="display:grid;grid-template-columns:repeat(12,1fr);gap:3px;margin-top:4px">
            ${Array.from({length:24},(_,h)=>`<div class="hour-btn on" data-h="${h}" onclick="toggleHour(this)" style="text-align:center;padding:6px 0;font-size:11px;border-radius:4px;cursor:pointer;background:#dcfce7;color:#166534;border:1px solid #bbf7d0;user-select:none">${h}시</div>`).join('')}
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:16px">
          <button class="btn btn-primary" onclick="saveKeyword()" style="flex:1">저장</button>
          <button class="btn" onclick="closeAddModal()" style="flex:1">취소</button>
        </div>
      </div>
    </div>

    <style>
      .hour-btn.on{background:#dcfce7!important;color:#166534!important;border-color:#bbf7d0!important}
      .hour-btn.off{background:#f1f5f9!important;color:#94a3b8!important;border-color:#e2e8f0!important}
      #add-modal[style*="flex"]{display:flex!important}
    </style>

    <script>
    let allKwList = [];
    const accountId = '${selectedId}';

    // 모달
    function openAddModal(){ document.getElementById('add-modal').style.display='flex'; }
    function closeAddModal(){ document.getElementById('add-modal').style.display='none'; resetForm(); }

    function resetForm(){
      document.getElementById('add-keyword').value='';
      document.getElementById('add-kwid').value='';
      document.getElementById('add-rank').value='3';
      document.getElementById('add-maxbid').value='5000';
      document.getElementById('add-adjust').value='100';
      document.getElementById('add-device').value='MO';
      document.querySelectorAll('#add-schedule .hour-btn').forEach(b=>{b.classList.remove('off');b.classList.add('on');});
    }

    function toggleHour(el){
      el.classList.toggle('on');
      el.classList.toggle('off');
    }

    // 키워드 목록 불러오기
    async function loadKeywordList(){
      const btn=document.getElementById('load-kw-btn');
      btn.disabled=true; btn.textContent='불러오는 중...';
      try{
        const r=await fetch('/smart-sa/api/autobid/keywords?accountId='+accountId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        allKwList=j.keywords;
        document.getElementById('kw-search-wrap').style.display='block';
        renderKwPickList(allKwList);
      }catch(e){toast('오류: '+e.message,true);}
      finally{btn.disabled=false;btn.textContent='📋 키워드 목록 새로고침';}
    }

    function filterKwList(){
      const q=document.getElementById('kw-search').value.toLowerCase();
      renderKwPickList(allKwList.filter(k=>(k.keyword||'').toLowerCase().includes(q)||(k.campaignName||'').toLowerCase().includes(q)));
    }

    function renderKwPickList(list){
      document.getElementById('kw-pick-list').innerHTML=list.slice(0,100).map(k=>
        '<div onclick="pickKw(this)" data-id="'+k.keywordId+'" data-kw="'+k.keyword+'" data-camp="'+k.campaignName+'" data-ag="'+k.adgroupName+'" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid #f1f5f9;font-size:13px;display:flex;justify-content:space-between" onmouseover="this.style.background=\\'#f0f9ff\\'" onmouseout="this.style.background=\\'\\'"><span><strong>'+k.keyword+'</strong></span><span style="color:#94a3b8;font-size:11px">'+k.campaignName+' / '+k.adgroupName+'</span></div>'
      ).join('')||'<div style="padding:12px;color:#94a3b8;text-align:center">검색 결과 없음</div>';
    }

    function pickKw(el){
      document.getElementById('add-kwid').value=el.dataset.id;
      document.getElementById('add-keyword').value=el.dataset.kw;
      document.getElementById('add-keyword').dataset.camp=el.dataset.camp;
      document.getElementById('add-keyword').dataset.ag=el.dataset.ag;
    }

    // 저장
    async function saveKeyword(){
      const kwId=document.getElementById('add-kwid').value;
      if(!kwId) return toast('키워드를 선택해주세요.',true);
      const hours=Array.from(document.querySelectorAll('#add-schedule .hour-btn')).map(b=>b.classList.contains('on')?'1':'0').join('');
      const body={
        accountId, keyword_id:kwId,
        keyword:document.getElementById('add-keyword').value,
        campaign_name:document.getElementById('add-keyword').dataset.camp||'',
        adgroup_name:document.getElementById('add-keyword').dataset.ag||'',
        device:document.getElementById('add-device').value,
        target_rank:parseInt(document.getElementById('add-rank').value)||3,
        max_bid:parseInt(document.getElementById('add-maxbid').value)||5000,
        adjust_amt:parseInt(document.getElementById('add-adjust').value)||100,
        schedule:hours, enabled:true,
      };
      try{
        const r=await fetch('/smart-sa/api/autobid/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        toast('키워드 저장 완료');
        closeAddModal(); loadList();
      }catch(e){toast('오류: '+e.message,true);}
    }

    // 목록 로드
    async function loadList(){
      try{
        const r=await fetch('/smart-sa/api/autobid/list?accountId='+accountId);
        const j=await r.json();
        if(!j.ok) throw new Error(j.error);
        const kws=j.keywords;
        document.getElementById('ab-count').textContent=kws.length+'개 키워드';
        if(!kws.length){document.getElementById('ab-list').innerHTML='<div class="empty">등록된 자동입찰 키워드가 없습니다.<br><span style="font-size:12px;color:#cbd5e1">+ 키워드 추가 버튼으로 키워드를 등록해주세요.</span></div>';return;}

        const scheduleHtml=(sch)=>Array.from({length:24},(_,h)=>'<span style="display:inline-block;width:14px;height:14px;border-radius:2px;font-size:8px;line-height:14px;text-align:center;margin:0 1px;background:'+(sch[h]==='1'?'#dcfce7':'#f1f5f9')+';color:'+(sch[h]==='1'?'#166534':'#cbd5e1')+'">'+h+'</span>').join('');

        document.getElementById('ab-list').innerHTML='<table><thead><tr><th>키워드</th><th>캠페인 / 그룹</th><th style="text-align:center">지면</th><th style="text-align:center">희망순위</th><th style="text-align:right">최대입찰가</th><th style="text-align:right">조정금액</th><th style="text-align:center">현재순위</th><th style="text-align:center">현재입찰가</th><th>실행시간</th><th style="text-align:center">상태</th><th></th></tr></thead><tbody>'
          +kws.map(k=>'<tr>'
            +'<td><strong>'+k.keyword+'</strong></td>'
            +'<td style="font-size:12px;color:#64748b">'+k.campaign_name+'<br>'+k.adgroup_name+'</td>'
            +'<td style="text-align:center"><span class="badge '+(k.device==='PC'?'badge-blue':'badge-green')+'">'+k.device+'</span></td>'
            +'<td style="text-align:center;font-weight:600">'+k.target_rank+'위</td>'
            +'<td style="text-align:right">₩'+Number(k.max_bid).toLocaleString()+'</td>'
            +'<td style="text-align:right">₩'+Number(k.adjust_amt).toLocaleString()+'</td>'
            +'<td style="text-align:center">'+(k.last_rank>0?Number(k.last_rank).toFixed(1)+'위':'<span style="color:#cbd5e1">-</span>')+'</td>'
            +'<td style="text-align:center">'+(k.last_bid>0?'₩'+Number(k.last_bid).toLocaleString():'<span style="color:#cbd5e1">-</span>')+'</td>'
            +'<td style="font-size:10px">'+scheduleHtml(k.schedule||'111111111111111111111111')+'</td>'
            +'<td style="text-align:center"><label style="cursor:pointer"><input type="checkbox" '+(k.enabled?'checked':'')+' onchange="toggleEnable('+k.id+',this.checked)" style="accent-color:#03c75a"></label></td>'
            +'<td><button class="btn" style="padding:4px 8px;font-size:11px;color:#dc2626" onclick="deleteKw('+k.id+')">삭제</button></td>'
            +'</tr>').join('')
          +'</tbody></table>';
      }catch(e){document.getElementById('ab-list').innerHTML='<div class="empty">'+e.message+'</div>';}
    }

    async function toggleEnable(id,enabled){
      await fetch('/smart-sa/api/autobid/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,accountId,enabled})});
    }

    async function deleteKw(id){
      if(!confirm('이 키워드를 삭제하시겠습니까?')) return;
      const r=await fetch('/smart-sa/api/autobid/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,accountId})});
      const j=await r.json();
      if(j.ok) loadList(); else toast('삭제 실패',true);
    }

    loadList();
    </script>
  `;
  res.send(appLayout('자동입찰', content, user, 'autobid', await getLayoutOpts(req)));
});

// ─── 자동입찰 API ──────────────────────────────────────────────────
// 광고주 키워드 목록 (추가용)
router.get('/api/autobid/keywords', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

    const client = makeClient(creds, account.customer_id);
    const campaigns = await client.getCampaigns();
    const keywords = [];

    for (const camp of (campaigns || [])) {
      const ags = await client.getAdGroups(camp.nccCampaignId);
      for (const ag of (ags || [])) {
        const kws = await client.getKeywords(ag.nccAdgroupId);
        for (const kw of (kws || [])) {
          keywords.push({
            keywordId: kw.nccKeywordId, keyword: kw.keyword,
            campaignName: camp.name, adgroupName: ag.name,
            bidAmt: kw.bidAmt,
          });
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    res.json({ ok: true, keywords });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 등록 키워드 목록
router.get('/api/autobid/list', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.query.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    const keywords = await db.getAutoBidKeywords(account.id);
    res.json({ ok: true, keywords });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 키워드 저장
router.post('/api/autobid/save', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    await db.upsertAutoBidKeyword(account.id, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ON/OFF 토글
router.post('/api/autobid/toggle', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    await db.pool.query('UPDATE auto_bid_keywords SET enabled = $1 WHERE id = $2 AND account_id = $3',
      [req.body.enabled ? 1 : 0, req.body.id, account.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 키워드 삭제
router.post('/api/autobid/delete', requireLogin, async (req, res) => {
  try {
    const account = await db.getAccountById(req.body.accountId, req.session.userId);
    if (!account) return res.status(404).json({ ok: false, error: '광고주 없음' });
    await db.deleteAutoBidKeyword(req.body.id, account.id);
    res.json({ ok: true });
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
        const desc  = {daily:'어제 하루 성과 (매일 09:00)',weekly:'최근 7일 성과 (월요일 09:00)',monthly:'최근 30일 성과 (매월 1일 09:00)'}[t];
        return `<div class="card">
          <div class="card-body" style="text-align:center">
            <div style="font-size:32px;margin-bottom:12px">${{daily:'📅',weekly:'📆',monthly:'🗓'}[t]}</div>
            <h3 style="font-weight:600;margin-bottom:6px">${label} 리포트</h3>
            <p style="color:#64748b;font-size:12px;margin-bottom:16px">${desc}</p>
            <select id="acc-${t}" style="margin-bottom:10px">
              ${accounts.map(a=>`<option value="${a.id}" ${String(a.id) === String(req.session.selectedAccountId) ? 'selected' : ''}>${a.name}</option>`).join('')||'<option value="">광고주 없음</option>'}
            </select>
            <div style="display:flex;gap:6px">
              <button class="btn btn-outline" style="flex:1;justify-content:center" onclick="previewReport('${t}')">미리보기</button>
              <button class="btn btn-primary" style="flex:1;justify-content:center" onclick="triggerReport('${t}')">이메일 발송</button>
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">⏰ 자동 발송 스케줄</span></div>
      <div class="card-body">
        <table>
          <thead><tr><th>리포트</th><th>발송 시각</th><th>광고주별 설정</th><th>최근 발송</th></tr></thead>
          <tbody>
            ${['daily','weekly','monthly'].map(t => {
              const label = {daily:'일간',weekly:'주간',monthly:'월간'}[t];
              const time = {daily:'매일 09:00 KST',weekly:'매주 월요일 09:00 KST',monthly:'매월 1일 09:00 KST'}[t];
              const col = 'last_' + t + '_report';
              const lastDates = accounts.filter(a => a[col]).map(a => {
                const d = new Date(a[col]);
                return a.name + ' ' + d.toLocaleDateString('ko-KR') + ' ' + d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
              });
              const lastStr = lastDates.length > 0 ? lastDates.join('<br>') : '<span style="color:#94a3b8">발송 내역 없음</span>';
              return `<tr>
                <td><strong>${label}</strong></td>
                <td>${time}</td>
                <td style="display:flex;align-items:center;gap:8px">
                  광고주 설정에서 ON/OFF
                  <a href="/smart-sa/accounts/${req.session.selectedAccountId || (accounts[0]?.id || '')}/edit" class="btn btn-outline" style="font-size:11px;padding:2px 8px">설정 바로가기</a>
                </td>
                <td style="font-size:12px">${lastStr}</td>
              </tr>`;
            }).join('')}
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
        toast(json.message || '리포트 발송 완료!');
      } catch(e) { toast(e.message, true); }
    }

    function previewReport(type) {
      const id = document.getElementById('acc-'+type).value;
      if (!id) return toast('광고주를 선택해주세요.', true);
      window.open('/smart-sa/api/report/preview?type='+type+'&accountId='+id, '_blank');
    }
    </script>
  `;
  res.send(appLayout('리포트', content, user, 'reports', await getLayoutOpts(req)));
});

// API: 리포트 미리보기 (HTML 직접 반환)
router.get('/api/report/preview', requireLogin, async (req, res) => {
  try {
    const { type = 'daily', accountId } = req.query;
    if (!['daily', 'weekly', 'monthly'].includes(type)) return res.status(400).send('잘못된 타입');
    const account = await db.getAccountById(accountId, req.session.userId);
    if (!account) return res.status(404).send('광고주 없음');

    const creds = await db.getApiCredentials(req.session.userId);
    if (!creds) return res.status(400).send('API 계정 미등록');

    const enriched = { ...account, api_key: creds.api_key, secret_key: creds.secret_key };
    const { generatePreview } = require('../report/generator');

    res.set('Content-Type', 'text/html; charset=utf-8');
    const html = await generatePreview(enriched, type);
    res.send(html);
  } catch (err) {
    res.status(500).send(`<h2>리포트 생성 오류</h2><pre>${err.message}</pre>`);
  }
});

router.post('/api/report/trigger', requireLogin, async (req, res) => {
  const { type, accountId } = req.body;
  if (!['daily','weekly','monthly'].includes(type)) return res.status(400).json({ ok:false, error:'잘못된 타입' });
  const account = await db.getAccountById(accountId, req.session.userId);
  if (!account) return res.status(404).json({ ok:false, error:'광고주 없음' });

  const creds = await db.getApiCredentials(req.session.userId);
  if (!creds) return res.status(400).json({ ok: false, error: 'API 계정 미등록' });

  // account에 API 자격증명 + SMTP 자격증명 병합
  const smtp = await db.getSmtpCredentials(req.session.userId);
  const enriched = {
    ...account,
    api_key: creds.api_key, secret_key: creds.secret_key,
    // SMTP: 다우오피스 자동 연동
    email_host: 'smtp.daouoffice.com',
    email_port: 587,
    email_user: smtp?.daou_email || smtp?.username || '',
    email_pass: smtp?.smtp_pass || '',
  };
  try {
    const ok = await generateAndSend(enriched, type);
    if (ok) {
      await db.pool.query(`UPDATE ad_accounts SET last_${type}_report = CURRENT_TIMESTAMP WHERE id = $1`, [accountId]).catch(console.error);
      res.json({ ok: true, message: '리포트 발송 완료!' });
    } else {
      res.json({ ok: false, error: '리포트 생성 또는 이메일 발송에 실패했습니다. SMTP 설정을 확인해주세요.' });
    }
  } catch (err) {
    console.error('리포트 발송 오류:', err);
    res.json({ ok: false, error: `발송 실패: ${err.message}` });
  }
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
        // SMTP 자동 연동: 다우오피스 정보 사용
        const smtp = await db.getSmtpCredentials(account.user_id).catch(() => null);
        account.email_host = 'smtp.daouoffice.com';
        account.email_port = 587;
        account.email_user = smtp?.daou_email || smtp?.username || account.email_user || '';
        account.email_pass = smtp?.smtp_pass || account.email_pass || '';
        const ok = await generateAndSend(account, type).catch(() => false);
        if (ok) {
          await db.pool.query(`UPDATE ad_accounts SET last_${type}_report = CURRENT_TIMESTAMP WHERE id = $1`, [account.id]).catch(console.error);
        }
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

// ─── 대시보드 데이터 동기화 Cron ──────────────────────────────────────
const { runDashboardSync, runBackfill } = require('../sync/dashboardSync');

// 30분마다 실행: 어제+오늘 데이터 동기화
router.get('/api/cron/sync-dashboard', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const result = await runDashboardSync(50000);
    console.log(`✅ Cron [sync-dashboard]: ${result.totalSynced}건, ${result.elapsed}초`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('❌ Cron [sync-dashboard]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 매일 새벽 1시(KST) 실행: 과거 30일 백필
router.get('/api/cron/sync-backfill', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (process.env.VERCEL && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  try {
    const result = await runBackfill(50000, 30);
    console.log(`✅ Cron [sync-backfill]: ${result.totalSynced}건, ${result.elapsed}초`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('❌ Cron [sync-backfill]:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 수동 동기화 트리거 (관리자용)
router.post('/api/sync/trigger', requireLogin, async (req, res) => {
  try {
    const result = await runDashboardSync(50000);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = { router };
