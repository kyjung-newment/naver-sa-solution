/**
 * SHOPPINGKEYWORD_DETAIL reportTp 테스트
 * 쇼핑검색 검색어 텍스트가 포함되는지 확인
 */
require('dotenv').config();
const crypto = require('crypto');
const axios = require('axios');
const zlib = require('zlib');
const db = require('./src/db/database');

const BASE_URL = 'https://api.searchad.naver.com';
let creds = {};

function makeAuthHeaders(method, path) {
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', creds.secretKey).update(`${ts}.${method}.${path}`).digest('base64');
  return { 'Content-Type': 'application/json; charset=UTF-8', 'X-Timestamp': ts, 'X-API-KEY': creds.apiKey, 'X-Customer': creds.customerId, 'X-Signature': sig };
}

async function apiCall(method, path, params = {}, data = null) {
  const url = `${BASE_URL}${path}`;
  const headers = makeAuthHeaders(method.toUpperCase(), path);
  const response = await axios({ method, url, headers, params: Object.keys(params).length > 0 ? params : undefined, data: method !== 'GET' ? data : undefined, timeout: 15000 });
  return response.data;
}

async function downloadReport(downloadUrl) {
  const urlObj = new URL(downloadUrl);
  const path = urlObj.pathname;
  const headers = makeAuthHeaders('GET', path);
  const response = await axios({ method: 'GET', url: downloadUrl, headers, responseType: 'arraybuffer', timeout: 30000 });
  let text;
  try { text = zlib.gunzipSync(response.data).toString('utf-8'); } catch (e) { text = response.data.toString('utf-8'); }
  return text.trim().split('\n').filter(l => l.trim()).map(line => line.split('\t'));
}

async function tryReport(label, body) {
  console.log(`\n=== ${label} ===`);
  try {
    const report = await apiCall('POST', '/stat-reports', {}, body);
    console.log(`reportJobId: ${report.reportJobId}, status: ${report.status}`);

    let status = report.status, downloadUrl = report.downloadUrl;
    for (let i = 0; i < 25; i++) {
      if (status === 'BUILT' && downloadUrl) break;
      await new Promise(r => setTimeout(r, 1500));
      const check = await apiCall('GET', `/stat-reports/${report.reportJobId}`);
      status = check.status; downloadUrl = check.downloadUrl;
      if (status === 'ERROR') { console.log('빌드 실패'); return null; }
    }

    if (status !== 'BUILT') { console.log(`타임아웃: status=${status}`); return null; }

    const rows = await downloadReport(downloadUrl);
    console.log(`총 ${rows.length}행, 컬럼 수: ${rows[0]?.length}`);

    // 처음 5행 출력
    for (let i = 0; i < Math.min(5, rows.length); i++) {
      console.log(`행[${i}]: ${rows[i].join(' | ')}`);
    }

    // 한글 포함 컬럼 찾기
    if (rows.length > 0) {
      for (let ci = 0; ci < rows[0].length; ci++) {
        const hasKorean = rows.slice(0, 10).some(r => /[가-힣]/.test(r[ci] || ''));
        if (hasKorean) {
          const samples = rows.slice(0, 5).map(r => r[ci]).join(', ');
          console.log(`★ 한글 col[${ci}]: ${samples}`);
        }
      }
    }

    return rows;
  } catch (e) {
    const sc = e.response?.status || '';
    const rd = e.response?.data;
    const detail = typeof rd === 'object' ? JSON.stringify(rd).slice(0, 300) : String(rd || '').slice(0, 300);
    console.log(`실패 [${sc}]: ${detail}`);
    return null;
  }
}

async function main() {
  const accounts = await db.all(`
    SELECT ad_accounts.*, users.api_key, users.secret_key
    FROM ad_accounts JOIN users ON users.id = ad_accounts.user_id
    WHERE users.api_key != '' AND users.secret_key != '' LIMIT 1
  `);
  const account = accounts[0];
  creds = { apiKey: account.api_key, secretKey: account.secret_key, customerId: account.customer_id };
  console.log(`계정: ${account.name} (${account.customer_id})`);

  const kstYesterday = new Date(Date.now() + 9*3600000 - 86400000).toISOString().slice(0, 10);
  console.log(`날짜: ${kstYesterday}`);

  // 핵심 테스트: SHOPPINGKEYWORD_DETAIL
  const skRows = await tryReport('SHOPPINGKEYWORD_DETAIL', { reportTp: 'SHOPPINGKEYWORD_DETAIL', statDt: kstYesterday });

  // 추가: SHOPPINGKEYWORD_CONVERSION_DETAIL
  await tryReport('SHOPPINGKEYWORD_CONVERSION_DETAIL', { reportTp: 'SHOPPINGKEYWORD_CONVERSION_DETAIL', statDt: kstYesterday });

  // 추가: EXPKEYWORD (키워드확장 보고서)
  await tryReport('EXPKEYWORD', { reportTp: 'EXPKEYWORD', statDt: kstYesterday });

  // 추가: SHOPPINGBRANDPRODUCT
  await tryReport('SHOPPINGBRANDPRODUCT', { reportTp: 'SHOPPINGBRANDPRODUCT', statDt: kstYesterday });

  // skRows가 있으면 상세 분석
  if (skRows && skRows.length > 0) {
    console.log('\n=== SHOPPINGKEYWORD_DETAIL 상세 분석 ===');
    console.log(`컬럼 수: ${skRows[0].length}`);

    // 고유값 분포 확인
    for (let ci = 0; ci < skRows[0].length; ci++) {
      const uniqueVals = [...new Set(skRows.map(r => r[ci]))];
      const sample = uniqueVals.slice(0, 5).join(', ');
      console.log(`col[${ci}]: ${uniqueVals.length}개 고유값 | 샘플: ${sample}`);
    }
  }

  await db.pool.end();
  console.log('\n완료');
}

main().catch(e => { console.error('에러:', e.message); process.exit(1); });
