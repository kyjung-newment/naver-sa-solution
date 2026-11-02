/**
 * GFA(네이버 디스플레이) 원본 파일 업로드 — 파싱·정규화·집계
 *
 * 원칙
 *  - 전환 지표는 구매완료(구매완료 수 / 구매완료 전환매출액)만 사용한다. 장바구니·총 전환으로 대체하지 않는다.
 *  - CPC·CPM·CTR·ROAS 등 비율 지표는 파일 값을 쓰지 않고 합계에서 다시 계산한다.
 *  - 파일끼리 합산하지 않는다. 같은 기간을 다른 기준으로 자른 파일이므로 합치면 2배가 된다.
 *    각 표는 해당 차원을 가진 파일 하나에서만 집계하고, 요약은 성과 보고서 한 개를 기준으로 한다.
 */
const crypto = require('crypto');
const zlib = require('zlib');

const METRICS = ['cost', 'imp', 'clk', 'buy', 'sales'];

const HEADER_MAP = {
  '광고계정': 'account', '광고계정이름': 'account', '광고계정명': 'account', '광고계정id': 'accountId',
  '캠페인': 'campaign', '캠페인이름': 'campaign', '캠페인명': 'campaign', '캠페인id': 'campaignId', '캠페인목적': 'objective',
  '광고그룹': 'adgroup', '광고그룹이름': 'adgroup', '광고그룹명': 'adgroup', '광고그룹id': 'adgroupId',
  '애셋그룹': 'assetgroup', '애셋그룹이름': 'assetgroup', '애셋그룹명': 'assetgroup', '애셋그룹id': 'assetgroupId',
  '광고소재': 'creative', '광고소재이름': 'creative', '광고소재명': 'creative', '소재': 'creative', '소재명': 'creative', '소재이름': 'creative',
  '광고소재id': 'creativeId', '소재id': 'creativeId',
  '매체그룹': 'mediaGroup', '게재위치': 'placement', '매체그룹및게재위치': 'placement',
  '연령및성별': 'ageGender', '연령': 'age', '성별': 'gender',
  '기기': 'device', '기기및os': 'deviceOs', 'os': 'os',
  '일': 'date', '일자': 'date', '날짜': 'date', '기간': 'date', '주': 'week', '월': 'month', '시간': 'hour', '시간대': 'hour',
  '상품': 'product', '상품명': 'product', '상품이름': 'product',
  '상품id': 'productId', '쇼핑몰상품id': 'productId', '네이버쇼핑상품id': 'naverProductId',
  '총비용': 'cost', '비용': 'cost', '노출수': 'imp', '노출': 'imp', '클릭수': 'clk', '클릭': 'clk',
  '구매완료수': 'buy', '구매완료전환매출액': 'sales', '구매완료매출액': 'sales', '구매완료전환매출': 'sales',
};
const DIM_ORDER = ['account', 'accountId', 'campaign', 'campaignId', 'objective', 'adgroup', 'adgroupId', 'assetgroup', 'assetgroupId',
  'creative', 'creativeId', 'product', 'productId', 'naverProductId', 'date', 'week', 'month', 'hour',
  'mediaGroup', 'placement', 'ageGender', 'age', 'gender', 'device', 'deviceOs', 'os'];
const ENTITY_DIMS = ['account', 'campaign', 'adgroup', 'assetgroup', 'creative', 'product', 'productId'];
const ID_DIMS = ['accountId', 'campaignId', 'adgroupId', 'assetgroupId', 'creativeId', 'productId', 'naverProductId'];
const SEGMENT_DIMS = ['date', 'week', 'month', 'hour', 'mediaGroup', 'placement', 'ageGender', 'age', 'gender', 'device', 'deviceOs', 'os'];
const DIM_LABEL = {
  account: '광고 계정', campaign: '캠페인', objective: '캠페인 목적', adgroup: '광고 그룹', assetgroup: '애셋 그룹', creative: '광고 소재',
  product: '상품', productId: '상품 ID', date: '일', week: '주', month: '월', hour: '시간', mediaGroup: '매체 그룹', placement: '게재 위치',
  ageGender: '연령 및 성별', age: '연령', gender: '성별', device: '기기', deviceOs: '기기 및 OS', os: 'OS',
};

const normHeader = s => String(s == null ? '' : s).replace(/^﻿/, '').replace(/\s+/g, '').toLowerCase();
const cleanText = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// ─── 파일 → 표 ─────────────────────────────────────────────────
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').replace(/^﻿/, '');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); }
  catch (_) { return new TextDecoder('euc-kr').decode(buf); } // 엑셀에서 다시 저장한 CSV는 CP949
}

function parseDelimited(text) {
  const firstLine = text.slice(0, text.indexOf('\n') + 1 || text.length);
  const delim = (firstLine.match(/\t/g) || []).length > (firstLine.match(/,/g) || []).length ? '\t' : ',';
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

async function parseWorkbook(buf) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const rows = [];
  ws.eachRow({ includeEmpty: false }, r => {
    const out = [];
    for (let c = 1; c <= ws.columnCount; c++) {
      let v = r.getCell(c).value;
      if (v && typeof v === 'object') {
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        else if (v.richText) v = v.richText.map(t => t.text).join('');
        else if ('result' in v) v = v.result;
        else if ('text' in v) v = v.text;
      }
      out.push(v == null ? '' : v);
    }
    rows.push(out);
  });
  return rows;
}

async function readTable(buf, fileName) {
  if (/\.xls$/i.test(fileName || '')) throw new Error('.xls 형식은 읽을 수 없습니다. CSV 또는 .xlsx로 저장해 올려주세요.');
  const isZip = buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4B;
  const rows = isZip ? await parseWorkbook(buf) : parseDelimited(decodeText(buf));
  // 머리글 위에 안내 문구가 있어도 찾도록, 지표 열 이름이 2개 이상 있는 첫 행을 머리글로 본다
  const idx = rows.slice(0, 15).findIndex(r => r.filter(c => METRICS.includes(HEADER_MAP[normHeader(c)])).length >= 2);
  if (idx < 0) throw new Error('GFA 보고서 형식이 아닙니다. 총비용·노출수 같은 지표 열을 찾지 못했습니다.');
  return { headers: rows[idx].map(c => String(c == null ? '' : c)), rows: rows.slice(idx + 1) };
}

// ─── 값 정규화 ──────────────────────────────────────────────────
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v == null ? '' : v).replace(/[₩,%\s원]/g, '');
  if (s === '' || s === '-') return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}
const pad = n => String(n).padStart(2, '0');
function datesIn(v) {
  const s = String(v);
  const out = [];
  const re = /(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/g;
  let m;
  while ((m = re.exec(s))) out.push(`${m[1]}-${pad(m[2])}-${pad(m[3])}`);
  return out;
}
function spanOf(dim, v) {
  const ds = datesIn(v);
  if (ds.length) return { from: ds[0], to: ds[ds.length - 1] };
  if (dim === 'month') {
    const m = String(v).match(/(\d{4})\D{1,3}(\d{1,2})/);
    if (m) {
      const last = new Date(Date.UTC(+m[1], +m[2], 0)).getUTCDate();
      return { from: `${m[1]}-${pad(m[2])}-01`, to: `${m[1]}-${pad(m[2])}-${pad(last)}` };
    }
  }
  return null;
}
const isTotalWord = v => /^(전체|합계|총계|총합|total)$/i.test(v);
const isTotalEntity = v => isTotalWord(v) || /^.{0,12}\s[\d,]+개$/.test(v);

function parseAgeGender(raw) {
  const v = cleanText(raw);
  if (!v || v === '알 수 없음') return { age: '알 수 없음', gender: '알 수 없음' };
  let gender = '알 수 없음', rest = v;
  const g = v.match(/(여성|남성|성별 알 수 없음)$/);
  if (g) { gender = g[1] === '성별 알 수 없음' ? '알 수 없음' : g[1]; rest = v.slice(0, g.index).trim(); }
  const a = rest.match(/(\d+)\s*세?\s*~\s*(\d+)\s*세?/);
  return { age: a ? `${a[1]}~${a[2]}세` : '알 수 없음', gender };
}
function normAge(v) { const a = cleanText(v).match(/(\d+)\s*세?\s*~\s*(\d+)\s*세?/); return a ? `${a[1]}~${a[2]}세` : (cleanText(v) || '알 수 없음'); }
const ageSort = a => { const m = String(a).match(/^(\d+)/); return m ? +m[1] : 999; };
const genderSort = g => ({ 여성: 0, 남성: 1 }[g] ?? 2);

/**
 * 표 하나를 저장 가능한 형태로 정규화. 형식 문제면 사용자에게 보여줄 메시지로 throw.
 * @returns {kind, dims, rows, totals, warnings, signature, contentHash, detected}
 */
function normalizeTable(table, { since, until }) {
  const col = {};
  table.headers.forEach((h, i) => { const f = HEADER_MAP[normHeader(h)]; if (f && col[f] === undefined) col[f] = i; });

  const missing = METRICS.filter(m => col[m] === undefined);
  const buyMissing = missing.filter(m => m === 'buy' || m === 'sales');
  if (buyMissing.length) {
    const names = buyMissing.map(m => (m === 'buy' ? '구매완료 수' : '구매완료 전환매출액')).join(', ');
    throw new Error(`${names} 열이 없습니다. 전환은 구매완료 기준으로만 집계하므로 다른 전환 값으로 대체하지 않습니다. GFA '열 맞춤 설정'에서 해당 열을 포함해 다시 내려받아 주세요.`);
  }
  if (missing.length) {
    const names = { cost: '총비용', imp: '노출수', clk: '클릭수' };
    throw new Error(`${missing.map(m => names[m]).join(', ')} 열이 없습니다. GFA '열 맞춤 설정'에서 포함해 다시 내려받아 주세요.`);
  }

  let dims = DIM_ORDER.filter(d => col[d] !== undefined);
  const warnings = [];
  let badNum = 0;
  let parsed = [];
  let totalRow = null;

  for (const raw of table.rows) {
    if (!raw || raw.every(c => cleanText(c) === '')) continue;
    const d = {};
    for (const k of dims) d[k] = cleanText(raw[col[k]]);
    const m = {};
    for (const k of METRICS) { const n = toNum(raw[col[k]]); if (Number.isNaN(n)) { badNum++; m[k] = 0; } else m[k] = n; }
    // 합계 행 판별: 화면의 '전체 / 상품 70개 / 캠페인 6개' 행. 숫자 ID가 있으면 실제 데이터로 본다.
    const ents = ENTITY_DIMS.filter(k => dims.includes(k));
    const hasNumericId = ID_DIMS.some(k => dims.includes(k) && /^\d+$/.test(d[k]));
    if (ents.length && !hasNumericId && ents.every(k => isTotalEntity(d[k]) || d[k] === '')) { totalRow = m; continue; }
    parsed.push({ d, m });
  }
  if (!parsed.length) throw new Error('데이터 행이 없습니다. 조회 기간과 필터를 확인해 다시 내려받아 주세요.');

  // 기간 단위·오디언스가 '전체'인 열은 차원이 아니다. 일부만 '전체'면 소계 행이므로 그 행을 뺀다.
  for (const k of SEGMENT_DIMS.filter(x => dims.includes(x))) {
    const totals = parsed.filter(r => isTotalWord(r.d[k]) || r.d[k] === '').length;
    if (totals === parsed.length) dims = dims.filter(x => x !== k);
    else if (totals > 0 && parsed.some(r => isTotalWord(r.d[k]))) parsed = parsed.filter(r => !isTotalWord(r.d[k]));
  }
  if (badNum) warnings.push(`숫자로 읽지 못한 값 ${badNum}개를 0으로 처리했습니다.`);

  // 기간 검증: 파일에 날짜가 있으면 선택 기간과 어긋나는지 확인
  let detected = null;
  for (const k of ['date', 'week', 'month', 'hour'].filter(x => dims.includes(x))) {
    for (const r of parsed) {
      const sp = spanOf(k, r.d[k]);
      if (k === 'date' && sp) r.d[k] = sp.from;
      if (!sp) continue;
      detected = detected || { since: sp.from, until: sp.to };
      if (sp.from < detected.since) detected.since = sp.from;
      if (sp.to > detected.until) detected.until = sp.to;
    }
  }
  if (detected && since && until && (detected.since > until || detected.until < since || (dims.includes('date') && (detected.since < since || detected.until > until)))) {
    const e = new Error(`파일 데이터 기간(${detected.since} ~ ${detected.until})이 선택한 기간(${since} ~ ${until})과 다릅니다. 기간을 확인해 주세요.`);
    e.detected = detected;
    throw e;
  }

  const kind = dims.includes('product') || dims.includes('productId') ? 'product' : 'performance';
  const rows = parsed.map(r => [...dims.map(k => r.d[k]), ...METRICS.map(k => r.m[k])]);
  const totals = sumMetrics(parsed.map(r => r.m));
  if (totalRow && totalRow.cost > 0 && Math.abs(totalRow.cost - totals.cost) / totalRow.cost > 0.01) {
    warnings.push(`파일의 합계 행 총비용(${Math.round(totalRow.cost).toLocaleString('ko-KR')}원)과 행 합산(${Math.round(totals.cost).toLocaleString('ko-KR')}원)이 다릅니다. 표 일부만 내려받았는지 확인해 주세요.`);
  }
  const segDims = dims.filter(k => !ID_DIMS.includes(k) && k !== 'objective' && k !== 'account');
  const signature = `${kind}|${segDims.slice().sort().join(',')}`;
  const contentHash = crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex');
  return { kind, dims, rows, totals, warnings, signature, contentHash, detected };
}

async function parseUpload(buf, fileName, range) {
  return normalizeTable(await readTable(buf, fileName), range);
}

const packRows = rows => zlib.gzipSync(Buffer.from(JSON.stringify(rows), 'utf8'));
const unpackRows = buf => JSON.parse(zlib.gunzipSync(buf).toString('utf8'));

// ─── 지표 계산 ──────────────────────────────────────────────────
function withDerived(o) {
  o.ctr = o.imp > 0 ? o.clk / o.imp * 100 : 0;
  o.cpc = o.clk > 0 ? o.cost / o.clk : 0;
  o.cpm = o.imp > 0 ? o.cost / o.imp * 1000 : 0;
  o.cvr = o.clk > 0 ? o.buy / o.clk * 100 : 0;
  o.cpa = o.buy > 0 ? o.cost / o.buy : 0;
  o.roas = o.cost > 0 ? o.sales / o.cost * 100 : 0;
  return o;
}
function sumMetrics(list) {
  const t = { cost: 0, imp: 0, clk: 0, buy: 0, sales: 0 };
  for (const m of list) for (const k of METRICS) t[k] += m[k] || 0;
  return withDerived(t);
}

// ─── 기간 ───────────────────────────────────────────────────────
const DAY = 86400000;
const ymd = ms => new Date(ms).toISOString().slice(0, 10);
const toMs = s => Date.parse(s + 'T00:00:00Z');
function classifyPeriod(since, until) {
  const a = toMs(since), b = toMs(until);
  const days = Math.round((b - a) / DAY) + 1;
  const da = new Date(a);
  const monthEnd = ymd(Date.UTC(da.getUTCFullYear(), da.getUTCMonth() + 1, 0));
  if (da.getUTCDate() === 1 && until === monthEnd) return { type: 'monthly', label: '월간', cmp: '전월' };
  if (days === 7 && da.getUTCDay() === 1) return { type: 'weekly', label: '주간', cmp: '전주' };
  if (days === 1) return { type: 'daily', label: '일간', cmp: '전일' };
  return { type: 'custom', label: '맞춤', cmp: '전기' };
}
function previousRange(since, until) {
  const c = classifyPeriod(since, until);
  if (c.type === 'monthly') {
    const d = new Date(toMs(since));
    return { since: ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)), until: ymd(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)) };
  }
  const days = Math.round((toMs(until) - toMs(since)) / DAY) + 1;
  return { since: ymd(toMs(since) - days * DAY), until: ymd(toMs(since) - DAY) };
}
const periodText = (since, until) => (since === until ? since.replace(/-/g, '.') : `${since.replace(/-/g, '.')} ~ ${until.replace(/-/g, '.')}`);

// ─── 집계 모델 ──────────────────────────────────────────────────
function materialize(file) {
  const n = file.dims.length;
  return file.rows.map(r => {
    const o = {};
    file.dims.forEach((k, i) => { o[k] = r[i]; });
    METRICS.forEach((k, i) => { o[k] = r[n + i]; });
    if (o.ageGender !== undefined) { const p = parseAgeGender(o.ageGender); o._age = p.age; o._gender = p.gender; }
    if (o.age !== undefined) o._age = normAge(o.age);
    if (o.gender !== undefined) o._gender = o.gender || '알 수 없음';
    if (o.placement !== undefined) {
      const parts = o.placement.split('>').map(s => s.trim());
      o._media = o.mediaGroup || parts[0];
      o._place = o.placement;
    } else if (o.mediaGroup !== undefined) o._media = o.mediaGroup;
    if (o.deviceOs !== undefined) { o._device = o.device || o.deviceOs.split('>')[0].trim(); o._deviceOs = o.deviceOs; }
    else if (o.device !== undefined) o._device = o.device;
    if (o.hour !== undefined) { const m = String(o.hour).match(/(\d{1,2})\s*(?:시|:\d{2})/); o._hour = m ? `${pad(m[1])}시` : o.hour; }
    return o;
  });
}
function aggregate(rows, keyFn, fieldsFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k === null || k === undefined) continue;
    let g = map.get(k);
    if (!g) { g = { _key: k, ...(fieldsFn ? fieldsFn(r) : {}), cost: 0, imp: 0, clk: 0, buy: 0, sales: 0 }; map.set(k, g); }
    for (const m of METRICS) g[m] += r[m] || 0;
  }
  return [...map.values()].map(withDerived);
}
const byCost = (a, b) => b.cost - a.cost;
const campKey = r => r.campaignId || r.campaign;
const won = n => `${Math.round(n).toLocaleString('ko-KR')}원`;

/**
 * 저장된 파일들로 리포트 모델 생성.
 * @param files [{file_name, kind, dims, rows}]
 * @returns null (성과 보고서 없음) 또는 모델
 */
function buildModel(files) {
  const views = files.map(f => {
    const rows = materialize(f);
    return { f, rows, total: sumMetrics(rows) };
  });
  const perf = views.filter(v => v.f.kind === 'performance');
  const prod = views.filter(v => v.f.kind === 'product');
  if (!perf.length) return null;

  // 요약 기준: 총비용이 가장 큰 성과 보고서 (같으면 차원이 적은 파일)
  const base = perf.slice().sort((a, b) => (b.total.cost - a.total.cost) || (a.f.dims.length - b.f.dims.length))[0];
  const pick = test => perf.filter(v => v.rows.length && test(v.rows[0])).sort((a, b) => a.f.dims.length - b.f.dims.length)[0] || null;
  const view = (test, keyFn, fieldsFn, sort = byCost) => {
    const v = pick(test);
    return v ? aggregate(v.rows, keyFn, fieldsFn).sort(sort) : [];
  };
  const byLabel = (a, b) => String(a._label).localeCompare(String(b._label));
  const ageGenderSort = (a, b) => ageSort(a._label) - ageSort(b._label) || genderSort(a.gender) - genderSort(b.gender);
  const hasCampaign = r => r.campaign !== undefined;

  const warnings = [];
  const diff = (x, y) => (Math.max(x, y) > 0 ? Math.abs(x - y) / Math.max(x, y) : 0);
  for (const v of perf) {
    if (v === base) continue;
    const a = base.total, b = v.total;
    if (diff(a.cost, b.cost) > 0.01 || diff(a.buy, b.buy) > 0.01) {
      warnings.push(`'${v.f.file_name}' 합계(총비용 ${won(b.cost)}, 구매완료 ${b.buy}건)가 요약 기준 파일 '${base.f.file_name}'(총비용 ${won(a.cost)}, 구매완료 ${a.buy}건)과 다릅니다. 기간이나 필터가 같은지 확인해 주세요.`);
    }
  }

  const model = {
    baseFile: base.f.file_name,
    total: base.total,
    warnings,
    campaigns: view(hasCampaign, campKey, r => ({ _label: r.campaign, objective: r.objective })),
    objectives: view(r => r.objective !== undefined, r => r.objective, r => ({ _label: r.objective })),
    adgroups: view(r => r.adgroup !== undefined, r => r.adgroupId || `${r.campaign}|${r.adgroup}`, r => ({ _label: r.adgroup, campaign: r.campaign })),
    assetgroups: view(r => r.assetgroup !== undefined, r => r.assetgroupId || `${r.campaign}|${r.assetgroup}`, r => ({ _label: r.assetgroup, campaign: r.campaign })),
    creatives: view(r => r.creative !== undefined, r => r.creativeId || `${r.campaign}|${r.creative}`, r => ({ _label: r.creative, campaign: r.campaign })),
    medias: view(r => r._media !== undefined, r => r._media, r => ({ _label: r._media })),
    places: view(r => r._place !== undefined, r => r._place, r => ({ _label: r._place })),
    campaignPlaces: view(r => r._place !== undefined && hasCampaign(r), r => `${campKey(r)}|${r._place}`, r => ({ _label: r._place, campaign: r.campaign }),
      (a, b) => a.campaign.localeCompare(b.campaign, 'ko') || b.cost - a.cost),
    genders: view(r => r._gender !== undefined, r => r._gender, r => ({ _label: r._gender }), (a, b) => genderSort(a._label) - genderSort(b._label)),
    ages: view(r => r._age !== undefined, r => r._age, r => ({ _label: r._age }), (a, b) => ageSort(a._label) - ageSort(b._label)),
    ageGenders: view(r => r._age !== undefined && r._gender !== undefined, r => `${r._age}|${r._gender}`, r => ({ _label: r._age, gender: r._gender }), ageGenderSort),
    campaignAgeGenders: view(r => r._age !== undefined && r._gender !== undefined && hasCampaign(r), r => `${campKey(r)}|${r._age}|${r._gender}`, r => ({ _label: r._age, gender: r._gender, campaign: r.campaign }),
      (a, b) => a.campaign.localeCompare(b.campaign, 'ko') || ageGenderSort(a, b)),
    devices: view(r => r._device !== undefined, r => r._device, r => ({ _label: r._device })),
    deviceOses: view(r => r._deviceOs !== undefined, r => r._deviceOs, r => ({ _label: r._deviceOs })),
    byDate: view(r => r.date !== undefined, r => r.date, r => ({ _label: r.date }), byLabel),
    byWeek: view(r => r.week !== undefined, r => r.week, r => ({ _label: r.week }), byLabel),
    byMonth: view(r => r.month !== undefined, r => r.month, r => ({ _label: r.month }), byLabel),
    byHour: view(r => r._hour !== undefined, r => r._hour, r => ({ _label: r._hour }), byLabel),
    products: [],
    campaignProducts: [],
    productTotal: null,
  };

  // 상품 보고서: 요약에 합치지 않고 상품 시트에만 쓴다 (캠페인 성과와 합계가 일치하지 않음)
  const pv = prod.slice().sort((a, b) => b.f.dims.length - a.f.dims.length)[0];
  if (pv) {
    const prodKey = r => r.productId || r.product;
    const fields = r => ({ _label: r.product || r.productId, productId: r.productId, naverProductId: r.naverProductId });
    model.products = aggregate(pv.rows, prodKey, fields).sort(byCost);
    model.productTotal = pv.total;
    if (hasCampaign(pv.rows[0])) {
      model.campaignProducts = aggregate(pv.rows, r => `${campKey(r)}|${prodKey(r)}`, r => ({ ...fields(r), campaign: r.campaign }))
        .sort((a, b) => a.campaign.localeCompare(b.campaign, 'ko') || b.cost - a.cost);
      // 같은 캠페인끼리 상품 보고서와 성과 보고서 구매완료를 대조
      const campIds = new Set(pv.rows.map(campKey));
      const baseForCamp = pick(hasCampaign);
      if (baseForCamp) {
        const inCamp = sumMetrics(baseForCamp.rows.filter(r => campIds.has(campKey(r))));
        if (inCamp.buy !== pv.total.buy || Math.abs(inCamp.sales - pv.total.sales) > 1) {
          warnings.push(`상품 보고서 구매완료(${pv.total.buy}건, ${won(pv.total.sales)})가 같은 캠페인의 성과 보고서(${inCamp.buy}건, ${won(inCamp.sales)})와 다릅니다. 요약은 성과 보고서 기준이며, 상품 시트에는 상품 보고서 값을 그대로 표시합니다.`);
        }
      }
    }
  }
  return model;
}

// 어떤 GFA 보고서를 올리면 어떤 시트가 생기는지 (업로드 화면 체크리스트)
const FILE_GUIDE = [
  { key: 'campaigns', label: '캠페인별', how: '성과 보고서 · 분석 단위 캠페인' },
  { key: 'byDate', label: '일자별', how: '성과 보고서 · 분석 단위 캠페인 · 기간 단위 일' },
  { key: 'places', label: '매체·게재 위치별', how: '성과 보고서 · 게재 위치 매체 그룹 및 게재 위치' },
  { key: 'ageGenders', label: '연령·성별', how: '성과 보고서 · 오디언스 연령 및 성별' },
  { key: 'devices', label: '기기별', how: '성과 보고서 · 오디언스 기기' },
  { key: 'creatives', label: '소재별', how: '성과 보고서 · 분석 단위 광고 소재' },
  { key: 'products', label: '상품별', how: '상품 성과 보고서 · 분석 단위 캠페인' },
];
function coverage(model) {
  return FILE_GUIDE.map(g => ({ ...g, have: !!(model && model[g.key] && model[g.key].length) }));
}
const dimsLabel = dims => dims.filter(d => DIM_LABEL[d]).map(d => DIM_LABEL[d]).join(' · ');

module.exports = {
  parseUpload, normalizeTable, readTable, buildModel, coverage, dimsLabel, packRows, unpackRows,
  classifyPeriod, previousRange, periodText, withDerived, sumMetrics, parseAgeGender, FILE_GUIDE,
};
