// ─── 구글 시트 연동: 소재/키워드별 목표ROAS(손익분기 ROAS)·운영등급 반영 ──────
// 광고주가 관리하는 스프레드시트(링크 공유 '보기' 필요)를 CSV export로 읽어,
// 1행 헤더 이름('소재ID' / '손익분기 ROAS' / '운영등급') 기준으로 열을 찾아 매칭한다.
// 실패 시 사용자에게 보여줄 한국어 사유를 error 로 반환한다.
const bidDb = require('./db');
const logic = require('./logic');

// 스프레드시트 주소 → { id, gid } (gid는 #gid= 또는 ?gid= 어느 쪽이든)
function parseSheetUrl(url) {
  const m = String(url || '').match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) return null;
  const g = String(url).match(/[#?&]gid=(\d+)/);
  return { id: m[1], gid: g ? g[1] : null };
}

// CSV 파서 (따옴표·쉼표·개행 처리)
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuote) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuote = false;
      } else field += c;
    } else if (c === '"') inQuote = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// 손익분기 ROAS 값 → 배수(5.5 = 550%). '%'·쉼표 제거, 50 초과 값은 %로 간주해 ÷100
function parseRoas(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const hadPercent = s.includes('%');
  const n = parseFloat(s.replace(/[%,\s원]/g, ''));
  if (!isFinite(n) || n <= 0) return null;
  const v = (hadPercent || n > 50) ? n / 100 : n;
  return Math.round(v * 100) / 100;
}

// 헤더 행에서 열 위치 찾기 (공백 무시 포함 일치)
function findCol(header, label) {
  const want = label.replace(/\s/g, '');
  return header.findIndex(h => String(h || '').replace(/\s/g, '').includes(want));
}

const nowKstStr = () => {
  const k = logic.nowKST();
  const p = (n) => String(n).padStart(2, '0');
  return `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())}`;
};

/**
 * 시트 → 소재/키워드별 목표ROAS·운영등급 반영
 * @returns {ok, error?, matched, updatedRoas, updatedGrade, notFound, invalid, total, at}
 */
async function syncFromSheet(account, channel = 'shopping', { actor = '' } = {}) {
  const settings = await bidDb.getSettings(account.id, channel);
  const url = String(settings.sheet_sync_url || '').trim();
  if (!url) return { ok: false, error: '시트 주소가 설정되어 있지 않습니다. 설정 화면에서 스프레드시트 주소를 먼저 등록해주세요.' };
  const parsed = parseSheetUrl(url);
  if (!parsed) return { ok: false, error: '구글 스프레드시트 주소 형식을 인식할 수 없습니다. docs.google.com/spreadsheets/d/... 형태의 주소인지 확인해주세요.' };

  const csvUrl = `https://docs.google.com/spreadsheets/d/${parsed.id}/export?format=csv${parsed.gid != null ? `&gid=${parsed.gid}` : ''}`;
  let body;
  try {
    const res = await fetch(csvUrl, { redirect: 'follow' });
    if (!res.ok) {
      return { ok: false, error: `시트를 불러오지 못했습니다 (HTTP ${res.status}). 시트 공유 설정을 '링크가 있는 모든 사용자 - 뷰어'로 변경해주세요.` };
    }
    body = await res.text();
  } catch (e) {
    return { ok: false, error: `시트 요청에 실패했습니다: ${e.message}` };
  }
  if (body.trimStart().startsWith('<')) {
    return { ok: false, error: "시트에 접근할 수 없습니다. 공유 설정을 '링크가 있는 모든 사용자 - 뷰어'로 변경해주세요." };
  }

  const rows = parseCsv(body);
  if (!rows.length) return { ok: false, error: '시트에서 데이터를 읽지 못했습니다 (빈 시트).' };
  const header = rows[0];
  const idCol = findCol(header, '소재ID');
  if (idCol === -1) return { ok: false, error: "소재ID 열을 찾을 수 없습니다. 시트 1행에 '소재ID' 제목이 있는지 확인해주세요." };
  const roasCol = findCol(header, '손익분기ROAS');
  if (roasCol === -1) return { ok: false, error: "손익분기 ROAS 열을 찾을 수 없습니다. 시트 1행에 '손익분기 ROAS' 제목이 있는지 확인해주세요." };
  const gradeCol = findCol(header, '운영등급'); // 없으면 등급은 건너뜀

  const materials = await bidDb.getMaterials(account.id, { channel });
  const byId = {};
  for (const m of materials) byId[String(m.ncc_ad_id).trim()] = m;

  let matched = 0, updatedRoas = 0, updatedGrade = 0, notFound = 0, invalid = 0, total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[idCol] || '').trim();
    if (!id) continue;
    total++;
    const m = byId[id];
    if (!m) { notFound++; continue; }
    matched++;
    const sets = [], params = [];
    const target = parseRoas(r[roasCol]);
    if (target == null) invalid++;
    else if (Math.abs(parseFloat(m.target_roas) - target) > 0.0001) {
      params.push(target); sets.push(`target_roas = $${params.length}`);
      updatedRoas++;
    }
    if (gradeCol !== -1) {
      const grade = String(r[gradeCol] || '').trim().slice(0, 30);
      if (grade !== String(m.grade || '')) {
        params.push(grade); sets.push(`grade = $${params.length}`);
        updatedGrade++;
      }
    }
    if (sets.length) {
      params.push(m.id, account.id);
      await bidDb.pool.query(
        `UPDATE bid_materials SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND account_id = $${params.length}`, params);
    }
  }

  if (total === 0) return { ok: false, error: '시트에 소재ID 값이 있는 행이 없습니다.' };
  if (matched === 0) return { ok: false, error: `시트의 소재ID ${total}건이 등록된 ${channel === 'powerlink' ? '키워드' : '소재'}와 하나도 일치하지 않습니다. ID 값을 확인해주세요.` };

  const at = nowKstStr();
  await bidDb.setSetting(account.id, 'sheet_sync_at', at, actor, channel);
  await bidDb.audit(account.id, actor || 'sheet-sync', '시트 연동 (목표ROAS·운영등급)', {
    channel, total, matched, updatedRoas, updatedGrade, notFound, invalid,
  });
  return { ok: true, at, total, matched, updatedRoas, updatedGrade, notFound, invalid };
}

module.exports = { syncFromSheet, parseSheetUrl, parseCsv, parseRoas, findCol };
