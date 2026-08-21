// ─── 광고주 일괄 이관/삭제 (엑셀 업로드) ───────────────────────────
// 양식: [계정명 | 아이디(Customer ID) | 기존담당자아이디 | 변경담당자아이디]
//  - 변경담당자아이디가 비어 있으면 '삭제', 채워져 있으면 해당 담당자로 '이관'
//  - 매칭 키는 아이디(Customer ID) + 기존담당자아이디 (계정명은 확인용 — 불일치 시 경고만)
const ExcelJS = require('exceljs');
const db = require('../db/database');

const HEADERS = ['계정명', '아이디', '기존담당자아이디', '변경담당자아이디'];

// ── 양식 생성: 시트1=입력 양식, 시트2=현재 계정 목록(복사용) ──
async function buildTemplateXlsx() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('이관·삭제 입력');
  ws.getRow(1).values = HEADERS;
  ws.getRow(1).font = { bold: true };
  ws.getColumn(1).width = 26; ws.getColumn(2).width = 14; ws.getColumn(3).width = 20; ws.getColumn(4).width = 20;
  // 안내는 입력 열(A~D) 밖에 배치해 업로드 시 데이터로 오인되지 않게 함
  ws.getCell('F1').value = '작성 방법';
  ws.getCell('F1').font = { bold: true };
  ws.getCell('F2').value = '· 아이디 = 광고주 Customer ID (숫자)';
  ws.getCell('F3').value = '· 변경담당자아이디를 비우면 해당 광고주는 삭제됩니다 (모든 데이터 영구 삭제)';
  ws.getCell('F4').value = '· 변경담당자아이디를 채우면 해당 담당자에게 이관됩니다';
  ws.getCell('F5').value = '· 담당자 아이디는 "현재 계정 목록" 시트를 참고하세요';
  ws.getColumn(6).width = 70;

  const list = wb.addWorksheet('현재 계정 목록');
  list.getRow(1).values = ['계정명', '아이디', '담당자아이디', '담당자명', '일간', '주간', '월간'];
  list.getRow(1).font = { bold: true };
  list.getColumn(1).width = 26; list.getColumn(2).width = 14; list.getColumn(3).width = 20; list.getColumn(4).width = 12;
  const rows = await db.pool.query(`
    SELECT a.name, a.customer_id, u.username, u.name AS user_name,
           a.feat_daily_report AS fd, a.feat_weekly_report AS fw, a.feat_monthly_report AS fm
    FROM ad_accounts a JOIN users u ON u.id = a.user_id
    ORDER BY u.name, a.name`).then(r => r.rows);
  let r = 2;
  for (const a of rows) {
    list.getRow(r).values = [a.name, a.customer_id, a.username, a.user_name, a.fd ? 'ON' : '', a.fw ? 'ON' : '', a.fm ? 'ON' : ''];
    r++;
  }
  return wb.xlsx.writeBuffer();
}

// ── 업로드 파싱: base64 xlsx → [{name, customerId, fromUsername, toUsername, rowNo}] ──
async function parseBulkXlsx(base64) {
  const buf = Buffer.from(base64, 'base64');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('이관·삭제 입력') || wb.worksheets[0];
  if (!ws) throw new Error('시트를 찾을 수 없습니다');
  const cellText = (row, c) => String(row.getCell(c).text || '').trim();
  // 헤더 검증 (1행)
  const h1 = ws.getRow(1);
  const headerOk = cellText(h1, 1).includes('계정명') && cellText(h1, 2).includes('아이디');
  if (!headerOk) throw new Error('양식이 올바르지 않습니다 — 1행 헤더가 [계정명, 아이디, 기존담당자아이디, 변경담당자아이디]인지 확인하세요');
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const name = cellText(row, 1);
    const customerId = cellText(row, 2).replace(/[^\d]/g, ''); // 엑셀 숫자 포맷(콤마 등) 방어
    const fromUsername = cellText(row, 3);
    const toUsername = cellText(row, 4);
    if (!name && !customerId && !fromUsername && !toUsername) return; // 빈 행
    rows.push({ rowNo: n, name, customerId, fromUsername, toUsername });
  });
  return rows;
}

// ── 행 검증: 각 행에 action(transfer|delete|error) + 상세 부여 ──
async function validateRows(rows) {
  const users = await db.pool.query(`SELECT id, name, username, approved FROM users`).then(r => r.rows);
  const userByUsername = {};
  for (const u of users) userByUsername[String(u.username || '').trim().toLowerCase()] = u;

  const accounts = await db.pool.query(`
    SELECT a.id, a.name, a.customer_id, a.user_id, u.username
    FROM ad_accounts a JOIN users u ON u.id = a.user_id`).then(r => r.rows);
  const accByKey = {}; // customerId|username(lower) → account
  const ownedByUser = {}; // userId → Set(customerId)
  for (const a of accounts) {
    accByKey[`${a.customer_id}|${String(a.username || '').trim().toLowerCase()}`] = a;
    if (!ownedByUser[a.user_id]) ownedByUser[a.user_id] = new Set();
    ownedByUser[a.user_id].add(a.customer_id);
  }

  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const res = { ...r, action: 'error', warning: '', accountId: null, accountName: '', toUserId: null, toUserName: '' };
    const fromKey = String(r.fromUsername || '').trim().toLowerCase();
    if (!r.customerId) { res.error = '아이디(Customer ID) 없음'; out.push(res); continue; }
    if (!fromKey) { res.error = '기존담당자아이디 없음'; out.push(res); continue; }
    if (!userByUsername[fromKey]) { res.error = `기존담당자 아이디를 찾을 수 없음 (${r.fromUsername})`; out.push(res); continue; }
    const acc = accByKey[`${r.customerId}|${fromKey}`];
    if (!acc) { res.error = '해당 담당자에게 등록된 광고주를 찾을 수 없음 (아이디·기존담당자 확인)'; out.push(res); continue; }
    const dupKey = `${acc.id}`;
    if (seen.has(dupKey)) { res.error = '중복 행 (같은 광고주가 이미 위에서 처리됨)'; out.push(res); continue; }
    seen.add(dupKey);
    res.accountId = acc.id;
    res.accountName = acc.name;
    if (r.name && acc.name && r.name !== acc.name) res.warning = `계정명 불일치 (등록명: ${acc.name})`;

    const toKey = String(r.toUsername || '').trim().toLowerCase();
    if (!toKey) {
      res.action = 'delete';
    } else {
      const toUser = userByUsername[toKey];
      if (!toUser) { res.error = `변경담당자 아이디를 찾을 수 없음 (${r.toUsername})`; out.push(res); continue; }
      if (!toUser.approved) { res.error = `변경담당자가 미승인 상태 (${r.toUsername})`; out.push(res); continue; }
      if (toUser.id === acc.user_id) { res.error = '기존담당자와 변경담당자가 동일'; out.push(res); continue; }
      if (ownedByUser[toUser.id] && ownedByUser[toUser.id].has(r.customerId)) {
        res.error = `변경담당자가 이미 같은 광고주(${r.customerId})를 보유 중`; out.push(res); continue;
      }
      res.action = 'transfer';
      res.toUserId = toUser.id;
      res.toUserName = toUser.name;
    }
    out.push(res);
  }
  return out;
}

// ── 실행: 검증 통과 행만 순차 처리 (이관=담당자 변경+자격증명 연결 해제, 삭제=CASCADE) ──
async function applyRows(validRows, actor) {
  const results = [];
  for (const r of validRows) {
    try {
      if (r.action === 'transfer') {
        // 자격증명 연결 해제 — 기존 담당자의 agency_credentials를 참조한 채 이관되면 잘못된 키로 동작
        await db.pool.query(`UPDATE ad_accounts SET user_id = $1, agency_credential_id = NULL WHERE id = $2`, [r.toUserId, r.accountId]);
        results.push({ ...r, ok: true });
      } else if (r.action === 'delete') {
        await db.pool.query(`DELETE FROM ad_accounts WHERE id = $1`, [r.accountId]);
        results.push({ ...r, ok: true });
      } else {
        results.push({ ...r, ok: false, error: r.error || '검증 실패' });
        continue;
      }
      db.pool.query(
        `INSERT INTO account_admin_log (action, account_id, account_name, customer_id, from_username, to_username, actor)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.action, r.accountId, r.accountName, r.customerId, r.fromUsername, r.toUsername || '', actor || '']
      ).catch(() => {});
    } catch (e) {
      results.push({ ...r, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = { buildTemplateXlsx, parseBulkXlsx, validateRows, applyRows, HEADERS };
