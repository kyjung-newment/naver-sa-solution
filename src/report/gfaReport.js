/**
 * GFA 업로드 데이터 리포트 — DA 단독 + SA+DA 통합
 *  - 전환 지표는 전부 구매완료 기준. SA는 purchaseCnt/purchaseAmt, DA는 구매완료 수/구매완료 전환매출액.
 *  - 비율 지표(CTR·CPC·CPM·ROAS 등)는 합계에서 다시 계산한다.
 */
const path = require('path');
const fs = require('fs');
const { withDerived } = require('./gfaUpload');

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => Math.round(Number(n) || 0).toLocaleString('ko-KR');
const won = n => `₩${num(n)}`;
const pct = n => `${(Number(n) || 0).toFixed(2)}%`;

// SA 지표 객체 → 공통 형식 (구매완료만 사용)
function fromSa(o) {
  return withDerived({ cost: o?.cost || 0, imp: o?.imp || 0, clk: o?.clk || 0, buy: o?.purchaseCnt || 0, sales: o?.purchaseAmt || 0 });
}
function addUp(a, b) {
  return withDerived({ cost: a.cost + b.cost, imp: a.imp + b.imp, clk: a.clk + b.clk, buy: a.buy + b.buy, sales: a.sales + b.sales });
}
function changeText(cur, prev) {
  if (prev == null) return '-';
  if (!prev) return cur ? '신규' : '-';
  const p = (cur - prev) / Math.abs(prev) * 100;
  if (Math.abs(p) < 0.05) return '0.0%';
  return `${p > 0 ? '▲' : '▼'}${Math.abs(p).toFixed(1)}%`;
}

// ═══════════════════════════════════════════════════════════════
// Excel
// ═══════════════════════════════════════════════════════════════
const C = {
  green: 'FF03C75A', dark: 'FF111827', white: 'FFFFFFFF', headerBg: 'FFF3F4F6', border: 'FFD9D9D9',
  altRow: 'FFFAFBFC', totalBg: 'FFF1F5F9', red: 'FFDC2626', blue: 'FF1D4ED8', gray: 'FF6B7280',
  purple: 'FF7C3AED', greenT: 'FF16A34A', noteBg: 'FFFFFBEB', noteText: 'FF92400E',
};
const FMT = { num: '#,##0', won: '₩#,##0', pct: '0.00"%"', text: '@' };
const border = { top: { style: 'thin', color: { argb: C.border } }, bottom: { style: 'thin', color: { argb: C.border } }, left: { style: 'thin', color: { argb: C.border } }, right: { style: 'thin', color: { argb: C.border } } };
const center = { horizontal: 'center', vertical: 'middle' };
const solid = argb => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const METRIC_COLS = [
  { h: '총비용', k: 'cost', fmt: FMT.won },
  { h: '노출수', k: 'imp', fmt: FMT.num },
  { h: '평균 CPM', k: 'cpm', fmt: FMT.won },
  { h: '클릭수', k: 'clk', fmt: FMT.num },
  { h: '평균 CPC', k: 'cpc', fmt: FMT.won },
  { h: '클릭률(%)', k: 'ctr', fmt: FMT.pct },
  { h: '구매완료 수', k: 'buy', fmt: FMT.num, color: C.purple, bold: true },
  { h: '구매전환율(%)', k: 'cvr', fmt: FMT.pct },
  { h: '구매당 비용', k: 'cpa', fmt: FMT.won },
  { h: '구매완료 전환매출액', k: 'sales', fmt: FMT.won, color: C.greenT },
  { h: '구매완료 ROAS(%)', k: 'roas', fmt: FMT.pct, bold: true },
];
const metricCols = () => METRIC_COLS.map(m => ({ h: m.h, get: d => d[m.k], fmt: m.fmt, color: m.color, bold: m.bold }));
const label = (h, get) => ({ h, get, label: true });

function newSheet(wb, name, labelWidths, metricWidth = 14, metricCount = METRIC_COLS.length) {
  const ws = wb.addWorksheet(name);
  ws.properties.defaultRowHeight = 20;
  ws.views = [{ showGridLines: false }];
  ws.getColumn(1).width = 2;
  labelWidths.forEach((w, i) => { ws.getColumn(i + 2).width = w; });
  for (let i = 0; i < metricCount; i++) ws.getColumn(labelWidths.length + 2 + i).width = metricWidth;
  return ws;
}
function titleBar(ws, r, text, span) {
  const row = ws.getRow(r); row.height = 30;
  ws.mergeCells(r, 2, r, span + 1);
  for (let c = 2; c <= span + 1; c++) { row.getCell(c).fill = solid(C.green); row.getCell(c).border = border; }
  const cell = row.getCell(2);
  cell.value = text; cell.font = { bold: true, size: 12, color: { argb: C.white } }; cell.alignment = center;
  return r + 1;
}
function noteRow(ws, r, text, span) {
  const row = ws.getRow(r); row.height = 34;
  ws.mergeCells(r, 2, r, span + 1);
  const cell = row.getCell(2);
  cell.value = text; cell.font = { size: 10, color: { argb: C.noteText } }; cell.fill = solid(C.noteBg);
  cell.alignment = { horizontal: 'left', vertical: 'middle', wrapText: true }; cell.border = border;
  return r + 1;
}
/** 표 하나를 쓰고 다음 빈 행 번호를 돌려준다. cols: [{h, get, fmt, label, color, bold}] */
function addTable(ws, r, { title, note, cols, rows, total, totalLabel = '합계' }) {
  if (title) r = titleBar(ws, r, title, cols.length);
  if (note) r = noteRow(ws, r, note, cols.length);
  const hr = ws.getRow(r); hr.height = 26;
  cols.forEach((c, i) => {
    const cell = hr.getCell(i + 2);
    cell.value = c.h; cell.font = { bold: true, size: 10, color: { argb: C.dark } };
    cell.fill = solid(C.headerBg); cell.alignment = { ...center, wrapText: true }; cell.border = border;
  });
  r++;
  const writeRow = (d, opt = {}) => {
    const row = ws.getRow(r); row.height = 21;
    cols.forEach((c, i) => {
      const cell = row.getCell(i + 2);
      const v = opt.total && c.label ? (i === 0 ? totalLabel : '') : c.get(d);
      cell.value = v == null ? '' : v;
      if (c.fmt && typeof v === 'number') cell.numFmt = c.fmt;
      cell.font = { size: 10, bold: !!(opt.bold || c.bold), color: { argb: c.color || (c.label ? C.dark : (opt.bold ? C.dark : C.gray)) } };
      cell.alignment = c.label ? { horizontal: 'left', vertical: 'middle' } : center;
      cell.border = border;
      if (opt.bg) cell.fill = solid(opt.bg);
      else if (opt.stripe) cell.fill = solid(C.altRow);
    });
    r++;
  };
  rows.forEach((d, i) => writeRow(d, { stripe: i % 2 === 1, bold: d._bold, bg: d._bg }));
  if (total) writeRow(total, { bold: true, bg: C.totalBg, total: true });
  return r + 1;
}
function metricTable(ws, r, { title, note, labels, rows, total }) {
  return addTable(ws, r, { title, note, cols: [...labels, ...metricCols()], rows, total });
}
function changeRow(cur, prev) {
  const o = {};
  METRIC_COLS.forEach(m => { o[m.k] = changeText(cur[m.k], prev ? prev[m.k] : null); });
  return o;
}

function loadLogo(wb) {
  try {
    const lp = path.join(__dirname, '..', 'assets', 'logo.png');
    if (fs.existsSync(lp)) return wb.addImage({ buffer: fs.readFileSync(lp), extension: 'png' });
  } catch (_) {}
  return null;
}

const CAMP = label('캠페인', d => d.campaign);
const NAME = h => label(h, d => d._label);

/** DA 시트 구성. 데이터가 있는 시트만 포함 (올린 파일에 따라 달라짐) */
function daSheetPlan({ model: m, prev, cmpLabel, period, accountName, typeLabel }) {
  const plan = [];
  const hasCampInCreative = list => list.length && list[0].campaign !== undefined;
  const notePurchase = '전환 지표는 모두 구매완료 기준입니다 (장바구니 등 다른 전환 제외).';

  plan.push({
    name: '요약·캠페인', desc: 'KPI 요약 + 캠페인별 성과', labels: [34],
    build(ws) {
      let r = 2;
      const summary = [{ _name: '당기', ...m.total, _bold: true }];
      if (prev) {
        summary.push({ _name: cmpLabel, ...prev.total });
        summary.push({ _name: '증감률', ...changeRow(m.total, prev.total) });
      }
      r = metricTable(ws, r, { title: `${accountName} · DA ${typeLabel} 성과 요약 (${period})`, note: notePurchase, labels: [label('구분', d => d._name)], rows: summary });
      if (m.campaigns.length) {
        r = metricTable(ws, r, { title: '캠페인별 성과', labels: [NAME('캠페인')], rows: m.campaigns, total: m.total });
      }
      if (m.objectives.length) {
        r = metricTable(ws, r, { title: '캠페인 목적별 성과', labels: [NAME('캠페인 목적')], rows: m.objectives, total: m.total });
      }
    },
  });

  if (prev && m.campaigns.length && prev.campaigns.length) {
    plan.push({
      name: '기간비교', desc: `캠페인·매체별 ${cmpLabel} 대비`, labels: [34], metricCount: 11,
      build(ws) {
        const cols = h => [
          label(h, d => d._label),
          { h: '당기 비용', get: d => d.c.cost, fmt: FMT.won }, { h: `${cmpLabel} 비용`, get: d => d.p.cost, fmt: FMT.won }, { h: '비용 증감', get: d => changeText(d.c.cost, d.p.cost) },
          { h: '당기 구매완료', get: d => d.c.buy, fmt: FMT.num, color: C.purple, bold: true }, { h: `${cmpLabel} 구매완료`, get: d => d.p.buy, fmt: FMT.num }, { h: '구매완료 증감', get: d => changeText(d.c.buy, d.p.buy) },
          { h: '당기 매출', get: d => d.c.sales, fmt: FMT.won, color: C.greenT }, { h: `${cmpLabel} 매출`, get: d => d.p.sales, fmt: FMT.won }, { h: '매출 증감', get: d => changeText(d.c.sales, d.p.sales) },
          { h: '당기 ROAS', get: d => d.c.roas, fmt: FMT.pct, bold: true }, { h: `${cmpLabel} ROAS`, get: d => d.p.roas, fmt: FMT.pct },
        ];
        const zero = withDerived({ cost: 0, imp: 0, clk: 0, buy: 0, sales: 0 });
        const pair = (cur, old) => {
          const keys = [...new Set([...cur.map(x => x._key), ...old.map(x => x._key)])];
          return keys.map(k => {
            const c = cur.find(x => x._key === k), p = old.find(x => x._key === k);
            return { _label: (c || p)._label, c: c || zero, p: p || zero };
          }).sort((a, b) => b.c.cost - a.c.cost);
        };
        let r = 2;
        r = addTable(ws, r, { title: `캠페인별 ${cmpLabel} 대비`, cols: cols('캠페인'), rows: pair(m.campaigns, prev.campaigns) });
        if (m.medias.length && prev.medias.length) r = addTable(ws, r, { title: `매체 그룹별 ${cmpLabel} 대비`, cols: cols('매체 그룹'), rows: pair(m.medias, prev.medias) });
      },
    });
  }

  if (m.byDate.length || m.byWeek.length || m.byMonth.length || m.byHour.length) {
    plan.push({
      name: '기간별', desc: '일자·주·월·시간대별 추이', labels: [24],
      build(ws) {
        let r = 2;
        if (m.byMonth.length) r = metricTable(ws, r, { title: '월별 성과', labels: [NAME('월')], rows: m.byMonth, total: m.total });
        if (m.byWeek.length) r = metricTable(ws, r, { title: '주별 성과', labels: [NAME('주')], rows: m.byWeek, total: m.total });
        if (m.byDate.length) r = metricTable(ws, r, { title: '일자별 성과', labels: [NAME('일자')], rows: m.byDate, total: m.total });
        if (m.byHour.length) r = metricTable(ws, r, { title: '시간대별 성과', labels: [NAME('시간')], rows: m.byHour, total: m.total });
      },
    });
  }

  if (m.medias.length || m.places.length) {
    plan.push({
      name: '매체별', desc: '매체 그룹·게재 위치별 성과', labels: [34],
      build(ws) {
        let r = 2;
        if (m.medias.length) r = metricTable(ws, r, { title: '매체 그룹별 성과', labels: [NAME('매체 그룹')], rows: m.medias, total: m.total });
        if (m.places.length) r = metricTable(ws, r, { title: '게재 위치별 성과', labels: [NAME('게재 위치')], rows: m.places, total: m.total });
      },
    });
  }
  if (m.campaignPlaces.length) {
    plan.push({
      name: '캠페인별 매체', desc: '캠페인 × 게재 위치', labels: [30, 30],
      build(ws) { metricTable(ws, 2, { title: '캠페인별 게재 위치 성과', labels: [CAMP, NAME('게재 위치')], rows: m.campaignPlaces, total: m.total }); },
    });
  }
  if (m.genders.length || m.ages.length) {
    plan.push({
      name: '연령·성별', desc: '성별·연령대별 성과', labels: [20],
      build(ws) {
        let r = 2;
        if (m.genders.length) r = metricTable(ws, r, { title: '성별 성과', labels: [NAME('성별')], rows: m.genders, total: m.total });
        if (m.ages.length) r = metricTable(ws, r, { title: '연령대별 성과', labels: [NAME('연령대')], rows: m.ages, total: m.total });
      },
    });
  }
  if (m.ageGenders.length) {
    plan.push({
      name: '연령×성별', desc: '연령대 × 성별', labels: [16, 14],
      build(ws) { metricTable(ws, 2, { title: '연령대 × 성별 성과', labels: [NAME('연령대'), label('성별', d => d.gender)], rows: m.ageGenders, total: m.total }); },
    });
  }
  if (m.campaignAgeGenders.length) {
    plan.push({
      name: '캠페인별 연령·성별', desc: '캠페인 × 연령대 × 성별', labels: [30, 14, 12],
      build(ws) { metricTable(ws, 2, { title: '캠페인별 연령·성별 성과', labels: [CAMP, NAME('연령대'), label('성별', d => d.gender)], rows: m.campaignAgeGenders, total: m.total }); },
    });
  }
  if (m.devices.length) {
    plan.push({
      name: '기기별', desc: '기기·OS별 성과', labels: [26],
      build(ws) {
        let r = 2;
        r = metricTable(ws, r, { title: '기기별 성과', labels: [NAME('기기')], rows: m.devices, total: m.total });
        if (m.deviceOses.length) r = metricTable(ws, r, { title: '기기·OS별 성과', labels: [NAME('기기 및 OS')], rows: m.deviceOses, total: m.total });
      },
    });
  }
  const entitySheet = (name, desc, list, h) => {
    if (!list.length) return;
    const withCamp = hasCampInCreative(list);
    plan.push({
      name, desc, labels: withCamp ? [28, 36] : [40],
      build(ws) { metricTable(ws, 2, { title: `${name.replace(/별$/, '')}별 성과`, labels: withCamp ? [CAMP, NAME(h)] : [NAME(h)], rows: list, total: m.total }); },
    });
  };
  entitySheet('광고그룹별', '광고 그룹별 성과', m.adgroups, '광고 그룹');
  entitySheet('애셋그룹별', '애셋 그룹별 성과', m.assetgroups, '애셋 그룹');
  entitySheet('소재별', '광고 소재별 성과', m.creatives, '광고 소재');
  if (m.products.length) {
    const prodNote = '상품 성과 보고서 값 그대로입니다. 네이버 집계 기준이 달라 합계가 요약(성과 보고서)과 다를 수 있습니다.';
    const ids = [label('쇼핑몰 상품 ID', d => d.productId || ''), label('네이버쇼핑 상품 ID', d => d.naverProductId || '')];
    plan.push({
      name: '상품별', desc: '상품별 성과 (상품 성과 보고서)', labels: [56, 16, 16],
      build(ws) { metricTable(ws, 2, { title: '상품별 성과', note: prodNote, labels: [NAME('상품'), ...ids], rows: m.products, total: m.productTotal }); },
    });
    if (m.campaignProducts.length) {
      plan.push({
        name: '캠페인별 상품', desc: '캠페인 × 상품', labels: [28, 56, 16, 16],
        build(ws) { metricTable(ws, 2, { title: '캠페인별 상품 성과', note: prodNote, labels: [CAMP, NAME('상품'), ...ids], rows: m.campaignProducts, total: m.productTotal }); },
      });
    }
  }
  return plan;
}

/** 워크북에 DA 시트를 추가한다. prefix는 SA+DA 통합 파일에서 시트명 충돌을 막는 접두어 */
function addDaSheets(wb, opts, prefix = '') {
  for (const s of daSheetPlan(opts)) {
    const ws = newSheet(wb, `${prefix}${s.name}`.slice(0, 31), s.labels, 14, s.metricCount || METRIC_COLS.length);
    s.build(ws);
  }
}

function buildCover(wb, { title, accountName, period, typeLabel, index }) {
  const ws = wb.addWorksheet('표지');
  ws.views = [{ showGridLines: false }];
  ws.getColumn(1).width = 2; ws.getColumn(2).width = 20; ws.getColumn(3).width = 34; ws.getColumn(4).width = 50;
  const logoId = loadLogo(wb);
  if (logoId !== null) ws.addImage(logoId, { tl: { col: 1, row: 0.4 }, ext: { width: 350, height: 37 } });
  let r = 4;
  ws.getRow(r).height = 55;
  ws.mergeCells(r, 2, r, 4);
  const tc = ws.getRow(r).getCell(2);
  tc.value = title; tc.font = { bold: true, size: 17, color: { argb: C.white } }; tc.fill = solid(C.green); tc.alignment = center;
  r += 2;
  const issued = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' });
  [['광고주', accountName], ['보고서 기간', period], ['보고서 유형', `${typeLabel} 리포트`], ['전환 기준', '구매완료 (장바구니 등 제외)'], ['발행일', issued], ['제작', '뉴먼트 솔루션 리포트']].forEach(([l, v]) => {
    const row = ws.getRow(r); row.height = 26;
    const a = row.getCell(2); a.value = l; a.font = { bold: true, size: 11, color: { argb: C.dark } }; a.fill = solid(C.headerBg); a.border = border; a.alignment = center;
    const b = row.getCell(3); b.value = v; b.font = { size: 11, color: { argb: C.dark } }; b.border = border; b.alignment = center;
    r++;
  });
  r += 2;
  ws.getRow(r).getCell(2).value = 'INDEX';
  ws.getRow(r).getCell(2).font = { bold: true, size: 13, color: { argb: C.dark } };
  r++;
  ['Sheet 순서', 'Sheet 명', '설명'].forEach((h, i) => {
    const c = ws.getRow(r).getCell(i + 2);
    c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } }; c.fill = solid(C.headerBg); c.border = border; c.alignment = center;
  });
  r++;
  index.forEach(([n, d], i) => {
    const row = ws.getRow(r + i); row.height = 22;
    [`sheet${i + 1}`, n, d].forEach((v, j) => {
      const c = row.getCell(j + 2);
      c.value = v; c.font = { size: 10, bold: j === 1, color: { argb: C.dark } }; c.border = border; c.alignment = center;
    });
  });
  return ws;
}

/** DA 단독 리포트 (엑셀) */
async function buildDaExcel({ accountName, period, typeLabel, cmpLabel, model, prev }) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = '뉴먼트 솔루션';
  wb.created = new Date();
  const opts = { accountName, period, typeLabel, cmpLabel, model, prev };
  buildCover(wb, {
    title: `${accountName} 네이버 디스플레이 ${typeLabel} 보고서`, accountName, period, typeLabel,
    index: daSheetPlan(opts).map(s => [s.name, s.desc]),
  });
  addDaSheets(wb, opts);
  return wb.xlsx.writeBuffer();
}

/** SA+DA 통합 요약 시트. 기존 SA 리포트 워크북의 표지 다음에 들어간다. */
function addCombinedSheet(wb, { accountName, period, typeLabel, data, prevData, daReport }) {
  const { model, prev, cmpLabel } = daReport;
  const sa = fromSa(data.total), da = model.total;
  const all = addUp(sa, da);
  const ws = newSheet(wb, '통합 요약', [24, 18], 14, METRIC_COLS.length + 2);
  let r = 2;

  // 1. 매체별 + 통합
  const share = (v, t) => (t > 0 ? v / t * 100 : 0);
  const rowsMedia = [
    { _name: '검색광고 (SA)', _src: '네이버 API', ...sa },
    { _name: '디스플레이 (DA)', _src: 'GFA 업로드', ...da },
  ];
  r = addTable(ws, r, {
    title: `${accountName} · SA+DA ${typeLabel} 통합 요약 (${period})`,
    note: '두 매체를 합산한 성과입니다. 전환 지표는 모두 구매완료 기준이며, 비율 지표는 합계에서 다시 계산했습니다.',
    cols: [
      label('매체', d => d._name), label('데이터 출처', d => d._src),
      ...metricCols(),
      { h: '비용 비중', get: d => share(d.cost, all.cost), fmt: FMT.pct },
      { h: '매출 비중', get: d => share(d.sales, all.sales), fmt: FMT.pct },
    ],
    rows: rowsMedia,
    total: { ...all },
    totalLabel: '통합 합계',
  });

  // 2. 전기 대비
  const prevSa = prevData && prevData.total ? fromSa(prevData.total) : null;
  const prevDa = prev ? prev.total : null;
  if (prevSa || prevDa) {
    const prevAll = prevSa && prevDa ? addUp(prevSa, prevDa) : null;
    const block = (name, cur, old) => {
      if (!old) return [{ _name: name, _when: '당기', ...cur, _bold: true }, { _name: '', _when: `${cmpLabel} 데이터 없음` }];
      return [
        { _name: name, _when: '당기', ...cur, _bold: true },
        { _name: '', _when: cmpLabel, ...old },
        { _name: '', _when: '증감률', ...changeRow(cur, old) },
      ];
    };
    const rows = [...block('통합', all, prevAll), ...block('검색광고 (SA)', sa, prevSa), ...block('디스플레이 (DA)', da, prevDa)];
    r = addTable(ws, r, {
      title: `${cmpLabel} 대비`,
      note: prevAll ? null : `${cmpLabel} ${prevDa ? 'SA' : 'DA'} 데이터가 없어 통합 ${cmpLabel} 대비는 표시하지 않습니다.${prevDa ? '' : ' 해당 기간의 DA 원본을 올리면 자동으로 비교됩니다.'}`,
      cols: [label('매체', d => d._name), label('기간', d => d._when), ...metricCols()],
      rows,
    });
  }

  // 3. 상세 유형별
  const saTypes = Object.entries(data.byCampaignType || {})
    .map(([k, v]) => ({ _name: '검색광고 (SA)', _type: k, ...fromSa(v) }))
    .filter(d => d.cost > 0 || d.imp > 0 || d.buy > 0)
    .sort((a, b) => b.cost - a.cost);
  const daKinds = model.objectives.length ? model.objectives : model.campaigns;
  const daTypes = daKinds.map(d => ({ _name: '디스플레이 (DA)', _type: d._label, ...d }));
  if (saTypes.length || daTypes.length) {
    r = addTable(ws, r, {
      title: `유형별 성과 (SA 캠페인 유형 · DA ${model.objectives.length ? '캠페인 목적' : '캠페인'})`,
      cols: [label('매체', d => d._name), label('유형', d => d._type), ...metricCols()],
      rows: [...saTypes, ...daTypes],
      total: { ...all },
      totalLabel: '통합 합계',
    });
  }

  // 4. 일자별 (DA 원본에 일자가 있을 때만)
  if (model.byDate.length && data.byDate) {
    const daMap = new Map(model.byDate.map(d => [d._label, d]));
    const dates = [...new Set([...Object.keys(data.byDate), ...daMap.keys()])].sort();
    const rows = dates.map(dt => {
      const s = fromSa(data.byDate[dt]);
      const d = daMap.get(dt) || withDerived({ cost: 0, imp: 0, clk: 0, buy: 0, sales: 0 });
      const t = addUp(s, d);
      return { _date: dt, _dow: ['일', '월', '화', '수', '목', '금', '토'][new Date(dt + 'T00:00:00Z').getUTCDay()] || '', sCost: s.cost, dCost: d.cost, tCost: t.cost, sBuy: s.buy, dBuy: d.buy, tBuy: t.buy, sSales: s.sales, dSales: d.sales, tSales: t.sales, tRoas: t.roas };
    });
    const c = (h, k, fmt, extra = {}) => ({ h, get: d => d[k], fmt, ...extra });
    const totalsRow = rows.reduce((a, x) => { for (const k of ['sCost', 'dCost', 'tCost', 'sBuy', 'dBuy', 'tBuy', 'sSales', 'dSales', 'tSales']) a[k] = (a[k] || 0) + x[k]; return a; }, {});
    totalsRow.tRoas = totalsRow.tCost > 0 ? totalsRow.tSales / totalsRow.tCost * 100 : 0;
    r = addTable(ws, r, {
      title: '일자별 통합 성과',
      cols: [label('일자', d => d._date), label('요일', d => d._dow),
        c('SA 비용', 'sCost', FMT.won), c('DA 비용', 'dCost', FMT.won), c('통합 비용', 'tCost', FMT.won, { bold: true }),
        c('SA 구매완료', 'sBuy', FMT.num), c('DA 구매완료', 'dBuy', FMT.num), c('통합 구매완료', 'tBuy', FMT.num, { bold: true, color: C.purple }),
        c('SA 매출', 'sSales', FMT.won), c('DA 매출', 'dSales', FMT.won), c('통합 매출', 'tSales', FMT.won, { bold: true, color: C.greenT }),
        c('통합 ROAS', 'tRoas', FMT.pct, { bold: true })],
      rows,
      total: totalsRow,
    });
  }
  return ws;
}

// ═══════════════════════════════════════════════════════════════
// HTML (메일 본문 · 미리보기)
// ═══════════════════════════════════════════════════════════════
const HEAD = title => `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>*{box-sizing:border-box}body{margin:0;padding:0;background:#f0f2f5;font-family:'Apple SD Gothic Neo','Noto Sans KR','Malgun Gothic',sans-serif;color:#111827;font-size:13px}</style></head><body>`;

function htmlTable(headers, rows) {
  const th = 'padding:8px 10px;font-size:11px;color:#6b7280;font-weight:600;border-bottom:2px solid #e5e7eb;background:#f9fafb;white-space:nowrap';
  const td = 'padding:8px 10px;font-size:12px;border-bottom:1px solid #f3f4f6';
  let h = `<table width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:12px"><thead><tr>${headers.map(x => `<th style="${th};text-align:${x.align || 'right'}">${x.label}</th>`).join('')}</tr></thead><tbody>`;
  rows.forEach((row, i) => {
    const bg = row._total ? '#f1f5f9' : (i % 2 ? '#fafbfc' : '#ffffff');
    h += `<tr style="background:${bg}">${row.cells.map((c, j) => {
      const cell = typeof c === 'object' ? c : { v: c };
      return `<td style="${td};text-align:${headers[j].align || 'right'};color:${cell.color || '#111827'};${cell.bold || row._total ? 'font-weight:600;' : ''}">${cell.v}</td>`;
    }).join('')}</tr>`;
  });
  return `${h}</tbody></table>`;
}
function htmlSection(title, content) {
  return `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:12px;margin-bottom:16px;overflow:hidden">
    <div style="padding:14px 20px;border-bottom:1px solid #f3f4f6;font-size:14px;font-weight:700;color:#111827">${title}</div>
    <div style="padding:16px 20px;overflow-x:auto">${content}</div></div>`;
}
const METRIC_HEAD = [{ label: '총비용' }, { label: '노출수' }, { label: '클릭수' }, { label: 'CTR' }, { label: 'CPC' }, { label: '구매완료 수' }, { label: '구매완료 매출' }, { label: 'ROAS' }];
const roasColor = v => (v >= 100 ? '#16a34a' : '#dc2626');
const metricCells = d => [won(d.cost), num(d.imp), { v: num(d.clk), color: '#1d4ed8' }, pct(d.ctr), won(d.cpc), { v: num(d.buy), color: '#7c3aed', bold: true }, { v: won(d.sales), color: '#16a34a' }, { v: pct(d.roas), color: roasColor(d.roas), bold: true }];

function metricHtml(firstLabel, items, total, limit) {
  const list = limit ? items.slice(0, limit) : items;
  const rows = list.map(d => ({ cells: [{ v: esc(d._label), bold: true }, ...metricCells(d)] }));
  if (total) rows.push({ _total: true, cells: ['합계', ...metricCells(total)] });
  return htmlTable([{ label: firstLabel, align: 'left' }, ...METRIC_HEAD], rows);
}
function kpiGrid(t, p, cmpLabel) {
  const change = (a, b) => {
    if (!p) return '';
    const s = changeText(a, b);
    const color = s[0] === '▲' ? '#16a34a' : s[0] === '▼' ? '#dc2626' : '#9ca3af';
    return `<div style="margin-top:3px;font-size:11px;color:${color}">${cmpLabel} ${s}</div>`;
  };
  const prev = p || {};
  const cards = [
    ['총비용', won(t.cost), '#ef4444', change(t.cost, prev.cost)],
    ['노출수', num(t.imp), '#111827', change(t.imp, prev.imp)],
    ['평균 CPM', won(t.cpm), '#111827', change(t.cpm, prev.cpm)],
    ['클릭수', num(t.clk), '#2563eb', change(t.clk, prev.clk)],
    ['평균 CPC', won(t.cpc), '#111827', change(t.cpc, prev.cpc)],
    ['클릭률', pct(t.ctr), '#111827', change(t.ctr, prev.ctr)],
    ['구매완료 수', num(t.buy), '#7c3aed', change(t.buy, prev.buy)],
    ['구매전환율', pct(t.cvr), '#111827', change(t.cvr, prev.cvr)],
    ['구매완료 매출', won(t.sales), '#16a34a', change(t.sales, prev.sales)],
    ['구매완료 ROAS', pct(t.roas), roasColor(t.roas), change(t.roas, prev.roas)],
  ];
  let h = '<table width="100%" cellspacing="0" cellpadding="0"><tr>';
  cards.forEach((c, i) => {
    if (i && i % 5 === 0) h += '</tr><tr>';
    h += `<td style="width:20%;padding:4px 5px;vertical-align:top"><div style="background:#f9fafb;border:1px solid #f0f0f0;border-radius:10px;text-align:center;padding:14px 6px;min-height:84px">
      <div style="font-size:10px;color:#6b7280;margin-bottom:4px;white-space:nowrap">${c[0]}</div>
      <div style="font-size:16px;font-weight:800;color:${c[2]}">${c[1]}</div>${c[3]}</div></td>`;
  });
  return `${h}</tr></table>`;
}
function headerHtml(eyebrow, title, period) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Seoul' });
  return `<div style="background:linear-gradient(135deg,#03c75a,#02a84e);border-radius:14px 14px 0 0;padding:26px 28px 20px">
    <p style="margin:0;color:rgba(255,255,255,.75);font-size:12px;letter-spacing:.05em">${eyebrow}</p>
    <h1 style="margin:6px 0 0;color:#fff;font-size:21px;font-weight:800">${esc(title)}</h1>
    <p style="margin:8px 0 0;color:rgba(255,255,255,.9);font-size:13px">기간: ${esc(period)} · 발행일: ${today}</p></div>`;
}

/** DA 리포트 본문 (DOCTYPE 포함) */
function buildDaHtml({ accountName, period, typeLabel, cmpLabel, model: m, prev }) {
  let h = `${HEAD(`${accountName} DA ${typeLabel} 리포트`)}<div style="max-width:900px;margin:0 auto;padding:20px 12px">`;
  h += headerHtml('NAVER DISPLAY AD REPORT', `${accountName} · DA ${typeLabel} 성과 리포트`, period);
  h += `<div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:16px 15px 12px;margin-bottom:16px">${kpiGrid(m.total, prev?.total, cmpLabel)}</div>`;
  if (m.campaigns.length) h += htmlSection('캠페인별 성과', metricHtml('캠페인', m.campaigns, m.total));
  if (m.byDate.length) h += htmlSection('일자별 성과', metricHtml('일자', m.byDate, m.total));
  if (m.medias.length) h += htmlSection('매체 그룹별 성과', metricHtml('매체 그룹', m.medias, m.total));
  if (m.places.length) h += htmlSection('게재 위치별 성과', metricHtml('게재 위치', m.places, m.total, 15));
  if (m.genders.length) h += htmlSection('성별 성과', metricHtml('성별', m.genders, m.total));
  if (m.ages.length) h += htmlSection('연령대별 성과', metricHtml('연령대', m.ages, m.total));
  if (m.devices.length) h += htmlSection('기기별 성과', metricHtml('기기', m.devices, m.total));
  if (m.creatives.length) h += htmlSection('소재별 성과 (비용 상위 10개)', metricHtml('광고 소재', m.creatives, null, 10));
  if (m.products.length) {
    h += htmlSection('상품별 성과 (비용 상위 15개)', `${metricHtml('상품', m.products, null, 15)}<p style="margin:10px 0 0;font-size:11px;color:#6b7280">상품 성과 보고서 값입니다. 네이버 집계 기준이 달라 합계가 요약과 다를 수 있습니다.</p>`);
  }
  h += `<div style="background:#fff;border:1px solid #e5e7eb;border-radius:0 0 14px 14px;padding:18px;text-align:center;color:#6b7280;font-size:11px;line-height:1.6">
    네이버 디스플레이 광고(GFA) 보고서 기준이며, 전환 지표는 모두 구매완료 기준입니다.<br>전체 상세는 첨부된 엑셀 파일에서 확인하실 수 있습니다. · NEWMENT</div>`;
  return `${h}</div></body></html>`;
}

function bodyOf(html) {
  const m = String(html).match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : String(html);
}

/** SA+DA 통합 메일 본문: 통합 요약 + SA 본문 + DA 본문 */
function buildCombinedHtml({ accountName, period, typeLabel, data, prevData, saHtml, daReport }) {
  const { model, prev, cmpLabel } = daReport;
  const sa = fromSa(data.total), da = model.total, all = addUp(sa, da);
  const prevSa = prevData && prevData.total ? fromSa(prevData.total) : null;
  const prevAll = prevSa && prev ? addUp(prevSa, prev.total) : null;
  const rows = [
    { cells: [{ v: '검색광고 (SA)', bold: true }, ...metricCells(sa)] },
    { cells: [{ v: '디스플레이 (DA)', bold: true }, ...metricCells(da)] },
    { _total: true, cells: ['통합 합계', ...metricCells(all)] },
  ];
  let top = `<div style="max-width:900px;margin:0 auto;padding:20px 12px 0">`;
  top += headerHtml('NAVER SA + DA INTEGRATED REPORT', `${accountName} · SA+DA ${typeLabel} 통합 리포트`, period);
  top += `<div style="background:#fff;border:1px solid #e5e7eb;border-top:none;padding:16px 15px 12px;margin-bottom:16px">${kpiGrid(all, prevAll, cmpLabel)}</div>`;
  top += htmlSection('매체별 통합 요약', `${htmlTable([{ label: '매체', align: 'left' }, ...METRIC_HEAD], rows)}<p style="margin:10px 0 0;font-size:11px;color:#6b7280">전환 지표는 두 매체 모두 구매완료 기준입니다. 아래에 매체별 상세가 이어집니다.</p>`);
  top += '</div>';
  const daHtml = buildDaHtml({ accountName, period, typeLabel, cmpLabel, model, prev });
  return `${HEAD(`${accountName} SA+DA ${typeLabel} 리포트`)}${top}${bodyOf(saHtml)}${bodyOf(daHtml)}</body></html>`;
}

module.exports = { buildDaExcel, buildDaHtml, buildCombinedHtml, addCombinedSheet, addDaSheets, daSheetPlan, fromSa };
