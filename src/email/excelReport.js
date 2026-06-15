const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

// 포맷 헬퍼
const f = {
  num: n => Number(n || 0).toLocaleString('ko-KR'),
  won: n => `₩${Number(n || 0).toLocaleString('ko-KR')}`,
};

async function buildExcelReport({ type, period, accountName, data, prevData, dateRange, prevRange, isCustom, reportConfig, suggestions }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '뉴먼트 솔루션';
  wb.created = new Date();

  const typeLabel = isCustom ? '맞춤' : ({ daily: '일간', weekly: '주간', monthly: '월간' }[type] || type);
  const diffLabel = isCustom ? '전기 대비' : ({ daily: '전일 대비', weekly: '전주 대비', monthly: '전월 대비' }[type] || '전기 대비');
  const t = data.total;
  const pt = prevData?.total || null;
  const now = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });

  // 로고
  let logoId = null;
  try {
    const lp = path.join(__dirname, '..', 'assets', 'logo.png');
    if (fs.existsSync(lp)) logoId = wb.addImage({ buffer: fs.readFileSync(lp), extension: 'png' });
  } catch (e) {}

  // ─── 컬러 ────────────────────────────────────────────────────────
  const C = {
    green: 'FF38AE49', dark: 'FF343539', white: 'FFFFFFFF',
    headerBg: 'FFF3F3F3', border: 'FFD9D9D9', altRow: 'FFF9FAFB',
    totalBg: 'FFEDF2F7', red: 'FFDC2626', blue: 'FF2563EB',
    gray: 'FF718096', purple: 'FF7C3AED',
  };
  const FMT = { num: '#,##0', won: '₩#,##0', pct: '0.00"%"', rank: '0.0', roas: '0"%"' };
  const border = { top: { style: 'thin', color: { argb: C.border } }, bottom: { style: 'thin', color: { argb: C.border } }, left: { style: 'thin', color: { argb: C.border } }, right: { style: 'thin', color: { argb: C.border } } };
  const cm = { horizontal: 'center', vertical: 'middle' };

  const mHeaders = ['총비용','노출수','평균순위','클릭수','CPC','CTR','구매완료','구매매출','ROAS','장바구니','장바구니매출'];
  const mFmts = [FMT.won, FMT.num, FMT.rank, FMT.num, FMT.won, FMT.pct, FMT.num, FMT.won, FMT.roas, FMT.num, FMT.won];

  // ─── 리포트 커스터마이징 설정 ────────────────────────────────────
  // reportConfig = { sheets: {summary:true,comparison:false,...}, customSheets:[{name,dimension,metrics,sortBy,limit}] }
  const cfg = reportConfig || {};
  const sheetOn = (k) => (cfg.sheets && cfg.sheets[k] === false) ? false : true; // 기본 on

  // 지표 레지스트리 (커스텀 시트용)
  const METRIC_DEFS = [
    { key: 'cost', label: '총비용', fmt: FMT.won },
    { key: 'imp', label: '노출수', fmt: FMT.num },
    { key: 'avgRank', label: '평균순위', fmt: FMT.rank },
    { key: 'clk', label: '클릭수', fmt: FMT.num },
    { key: 'cpc', label: 'CPC', fmt: FMT.won },
    { key: 'ctr', label: 'CTR', fmt: FMT.pct },
    { key: 'purchaseCnt', label: '구매완료', fmt: FMT.num },
    { key: 'purchaseAmt', label: '구매매출', fmt: FMT.won },
    { key: 'roas', label: 'ROAS', fmt: FMT.roas },
    { key: 'cartCnt', label: '장바구니', fmt: FMT.num },
    { key: 'cartAmt', label: '장바구니매출', fmt: FMT.won },
  ];
  // 차원 레지스트리 (커스텀 시트용)
  const DIMENSION_DEFS = {
    byCampaign:     { label: '캠페인',     labelHeaders: ['캠페인'],            labels: (d, k) => [d.name || k] },
    byCampaignType: { label: '캠페인유형', labelHeaders: ['캠페인유형'],        labels: (d, k) => [k] },
    byAdgroup:      { label: '광고그룹',   labelHeaders: ['캠페인', '광고그룹'], labels: (d, k) => [d.campaignName || '', d.name || k] },
    byKeyword:      { label: '키워드',     labelHeaders: ['광고그룹', '키워드'], labels: (d, k) => [d.adgroupName || '', d.name || k] },
    byQuery:        { label: '검색어',     labelHeaders: ['광고그룹', '검색어'], labels: (d, k) => [d.adgroupName || '', d.name || k] },
    byDevice:       { label: '디바이스',   labelHeaders: ['디바이스'],          labels: (d, k) => [k === 'P' || k === 'PC' ? 'PC' : '모바일'] },
    byHour:         { label: '시간대',     labelHeaders: ['시간'],              labels: (d, k) => [parseInt(k) + '시'] },
    byDate:         { label: '일자',       labelHeaders: ['일자'],              labels: (d, k) => [k] },
  };

  // ─── 공통 헬퍼 ───────────────────────────────────────────────────
  function setup(ws) { ws.properties.defaultRowHeight = 20; ws.views = [{ showGridLines: false }]; ws.getColumn(1).width = 2; }
  function logo(ws) { if (logoId !== null) ws.addImage(logoId, { tl: { col: 1, row: 1 }, ext: { width: 350, height: 37 } }); }

  function sectionTitle(ws, r, text, span = 13) {
    const row = ws.getRow(r); row.height = 40;
    ws.mergeCells(r, 2, r, span);
    for (let c = 2; c <= span; c++) { row.getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green } }; row.getCell(c).border = border; }
    const cell = row.getCell(2);
    cell.value = text; cell.font = { bold: true, size: 14, color: { argb: C.white } }; cell.alignment = cm;
    return r + 1;
  }

  function subTitle(ws, r, text, span = 13) {
    const row = ws.getRow(r); row.height = 26;
    if (span > 1) ws.mergeCells(r, 2, r, span);
    const cell = row.getCell(2);
    cell.value = text; cell.font = { bold: true, size: 11, color: { argb: C.dark } }; cell.alignment = { horizontal: 'left', vertical: 'middle' }; cell.border = border;
    return r + 1;
  }

  function tableHeader(ws, r, firstCols = ['구분']) {
    const row = ws.getRow(r); row.height = 26;
    [...firstCols, ...mHeaders].forEach((h, i) => {
      const c = row.getCell(i + 2);
      c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
      c.alignment = cm; c.border = border;
    });
    return r + 1;
  }

  function dataRow(ws, r, d, opts = {}) {
    const row = ws.getRow(r); row.height = 23;
    const sc = opts.startCol || 2;
    const labels = opts.labels || [];
    labels.forEach((lb, li) => {
      const c = row.getCell(sc + li);
      c.value = lb; c.font = { size: 10, bold: !!opts.bold, color: { argb: opts.labelColor || C.dark } };
      c.alignment = cm; c.border = border;
      if (opts.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
      else if (opts.stripe) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
    });
    const ms = sc + labels.length;
    const vals = [d.cost||0, d.imp||0, d.avgRank||0, d.clk||0, d.cpc||0, d.ctr||0, d.purchaseCnt||0, d.purchaseAmt||0, d.roas||0, d.cartCnt||0, d.cartAmt||0];
    vals.forEach((v, i) => {
      const c = row.getCell(ms + i);
      c.value = v; c.numFmt = mFmts[i];
      c.font = { size: 10, bold: !!opts.bold, color: { argb: opts.bold ? C.dark : C.gray } };
      c.alignment = cm; c.border = border;
      if (opts.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
      else if (opts.stripe) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
    });
    return r + 1;
  }

  function diffRow(ws, r, label, curr, prev) {
    const row = ws.getRow(r); row.height = 23;
    const lc = row.getCell(2);
    lc.value = label; lc.font = { size: 10, italic: true, color: { argb: C.gray } }; lc.alignment = cm; lc.border = border;
    const diffs = [curr.cost-prev.cost, curr.imp-prev.imp, (curr.avgRank||0)-(prev.avgRank||0), curr.clk-prev.clk, (curr.cpc||0)-(prev.cpc||0), (curr.ctr||0)-(prev.ctr||0), (curr.purchaseCnt||0)-(prev.purchaseCnt||0), (curr.purchaseAmt||0)-(prev.purchaseAmt||0), (curr.roas||0)-(prev.roas||0), (curr.cartCnt||0)-(prev.cartCnt||0), (curr.cartAmt||0)-(prev.cartAmt||0)];
    diffs.forEach((v, i) => {
      const c = row.getCell(3 + i); c.value = v; c.numFmt = mFmts[i];
      const costLike = [0, 4].includes(i);
      c.font = { size: 10, italic: true, color: { argb: v === 0 ? C.gray : ((v > 0) === costLike ? C.red : C.green) } };
      c.alignment = cm; c.border = border;
    });
    return r + 1;
  }

  function setColWidths(ws, firstWidths = [22]) {
    firstWidths.forEach((w, i) => { ws.getColumn(i + 2).width = w; });
    const s = firstWidths.length + 2;
    // 총비용, 노출수, 평균순위, 클릭수, CPC, CTR, 구매완료, 구매매출, ROAS, 장바구니, 장바구니매출
    [15, 13, 10, 12, 12, 10, 10, 16, 10, 10, 16].forEach((w, i) => { ws.getColumn(s + i).width = w; });
  }

  // ══════════════════════════════════════════════════════════════════
  // 1. 표지
  // ══════════════════════════════════════════════════════════════════
  const cover = wb.addWorksheet('표지');
  setup(cover); cover.getColumn(2).width = 20; cover.getColumn(3).width = 45; cover.getColumn(4).width = 45;
  logo(cover);

  let cr = 4;
  cover.getRow(cr).height = 55;
  cover.mergeCells(cr, 2, cr, 4);
  const tc = cover.getRow(cr).getCell(2);
  tc.value = `${accountName} 네이버 검색광고 ${typeLabel} 보고서`;
  tc.font = { bold: true, size: 17, color: { argb: C.white } };
  tc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green } };
  tc.alignment = cm;
  for (let c = 3; c <= 4; c++) { cover.getRow(cr).getCell(c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.green } }; cover.getRow(cr).getCell(c).border = border; }
  cr += 2;

  [['광고주', accountName], ['보고서 기간', period], ['보고서 유형', typeLabel + ' 리포트'], ['발행일', now], ['제작', '뉴먼트 솔루션 자동 리포트']].forEach(([l, v]) => {
    const row = cover.getRow(cr); row.height = 26;
    const lc = row.getCell(2); lc.value = l;
    lc.font = { bold: true, size: 11, color: { argb: C.dark } };
    lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    lc.border = border; lc.alignment = cm;
    const vc = row.getCell(3); vc.value = v;
    vc.font = { size: 11, color: { argb: C.dark } }; vc.border = border; vc.alignment = cm;
    cr++;
  });
  cr += 2;

  cover.getRow(cr).getCell(2).value = 'INDEX';
  cover.getRow(cr).getCell(2).font = { bold: true, size: 13, color: { argb: C.dark } };
  cr++;
  ['Sheet 순서', 'Sheet 명', '설명'].forEach((h, i) => {
    const c = cover.getRow(cr).getCell(i + 2);
    c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
    c.border = border; c.alignment = cm;
  });
  cr++;
  const sheetList = [['요약·캠페인','KPI 요약 + 캠페인별 성과']];
  if (prevData && type !== 'daily') sheetList.push(['기간비교','캠페인유형별·광고그룹별 전기간 비교']);
  const _hasQuery = data.byQuery && Object.keys(data.byQuery).length > 0
    && Object.values(data.byQuery).some(d => (d.cost || 0) > 0 || (d.clk || 0) > 0);
  const _kwIdxLabel = _hasQuery ? '검색어별' : '키워드별';
  const _kwIdxDesc = _hasQuery ? '검색어별 성과 (AD_QUERY_DETAIL)' : '키워드별 전환/ROAS/비효율 TOP';
  sheetList.push(['유형 및 기기별','캠페인유형별 + PC/모바일 성과'], ['광고그룹별','광고그룹별 성과 (TOP 10)'], [_kwIdxLabel, _kwIdxDesc], ['시간대별','구매전환매출 기준 시간대 분포'], ['일자별','일자별 성과 추이']);
  sheetList.forEach(([n, d], i) => {
    const row = cover.getRow(cr + i); row.height = 22;
    [{v:`sheet${i+1}`}, {v:n, bold:true}, {v:d}].forEach((item, j) => {
      const c = row.getCell(j + 2);
      c.value = item.v; c.font = { size: 10, bold: !!item.bold, color: { argb: C.dark } };
      c.border = border; c.alignment = cm;
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // 2. 요약·캠페인 (병합 시트)
  // ══════════════════════════════════════════════════════════════════
  const sum = wb.addWorksheet('요약·캠페인');
  setup(sum); setColWidths(sum, [25]); sum.getColumn(3).width = 25;

  let sr = 3;
  sr = sectionTitle(sum, sr, `${accountName} · ${typeLabel} 성과 요약`, 13);
  sr++;

  // KPI 카드 (1행 5개)
  const kpis = [
    { label: '총비용', value: t.cost||0, fmt: FMT.won, isCost: true },
    { label: '노출수', value: t.imp||0, fmt: FMT.num },
    { label: '클릭수', value: t.clk||0, fmt: FMT.num },
    { label: 'CTR', value: t.ctr||0, fmt: FMT.pct },
    { label: '평균순위', value: t.avgRank||0, fmt: FMT.rank, isCost: true },
  ];
  const kpis2 = [
    { label: 'CPC', value: t.cpc||0, fmt: FMT.won, isCost: true },
    { label: '구매매출', value: t.purchaseAmt||0, fmt: FMT.won },
    { label: 'ROAS', value: t.roas||0, fmt: FMT.roas },
    { label: '구매전환수', value: t.purchaseCnt||0, fmt: FMT.num },
    { label: '장바구니수', value: t.cartCnt||0, fmt: FMT.num },
  ];

  // 라벨
  const lblRow = sum.getRow(sr); lblRow.height = 18;
  kpis.forEach((k, i) => { const c = lblRow.getCell(2 + i); c.value = k.label; c.font = { size: 9, color: { argb: C.gray } }; c.alignment = cm; c.border = border; });
  sr++;
  // 값
  const valRow = sum.getRow(sr); valRow.height = 34;
  kpis.forEach((k, i) => {
    const c = valRow.getCell(2 + i); c.value = k.value; c.numFmt = k.fmt;
    c.font = { bold: true, size: 16, color: { argb: k.isCost ? C.red : C.blue } };
    c.alignment = cm; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.border = border;
  });
  sr++;
  // 전기비교
  if (pt) {
    const dRow = sum.getRow(sr); dRow.height = 18;
    kpis.forEach((k, i) => {
      const prev = [pt.cost||0, pt.imp||0, pt.clk||0, pt.ctr||0, pt.avgRank||0][i];
      const diff = k.value - prev;
      const c = dRow.getCell(2 + i); c.value = diff; c.numFmt = k.fmt;
      c.font = { size: 9, italic: true, color: { argb: diff === 0 ? C.gray : ((diff > 0) === !!k.isCost ? C.red : C.green) } };
      c.alignment = cm; c.border = border;
    });
  }
  sr += 2;

  // 2행 KPI
  const lblRow2 = sum.getRow(sr); lblRow2.height = 18;
  kpis2.forEach((k, i) => { const c = lblRow2.getCell(2 + i); c.value = k.label; c.font = { size: 9, color: { argb: C.gray } }; c.alignment = cm; c.border = border; });
  sr++;
  const valRow2 = sum.getRow(sr); valRow2.height = 34;
  kpis2.forEach((k, i) => {
    const c = valRow2.getCell(2 + i); c.value = k.value; c.numFmt = k.fmt;
    c.font = { bold: true, size: 16, color: { argb: k.isCost ? C.red : C.green } };
    c.alignment = cm; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.border = border;
  });
  sr += 3;

  // 캠페인별 성과 (요약 시트 하단에 병합)
  const campEntries = Object.entries(data.byCampaign).sort((a, b) => b[1].cost - a[1].cost);
  if (campEntries.length > 0) {
    sr = subTitle(sum, sr, `캠페인별 성과 현황 (${campEntries.length}개)`, 13);
    sr = tableHeader(sum, sr);
    campEntries.forEach(([, d], idx) => {
      sr = dataRow(sum, sr, d, { labels: [(idx < 5 ? `★ ${idx+1}. ` : '') + d.name], stripe: idx % 2 === 1, bold: idx < 5, labelColor: idx < 5 ? C.blue : undefined });
    });
    sr++;
    sr = dataRow(sum, sr, data.total, { labels: ['합계'], bold: true, bg: C.totalBg });
    if (pt) sr = diffRow(sum, sr, diffLabel, t, pt);
  }

  // ══════════════════════════════════════════════════════════════════
  // 2-1. 기간비교 (주간/월간만, prevData 있을 때) — 요약·캠페인 바로 다음
  // ══════════════════════════════════════════════════════════════════
  if (prevData && (type !== 'daily' || isCustom)) {
    function fmtRange(r) {
      if (!r) return '';
      const a = (r.since || '').replace(/-/g, '.'); const b = (r.until || '').replace(/-/g, '.');
      return a === b ? a : `${a}~${b}`;
    }
    const cmpLabel = isCustom ? '전기 대비' : ({ weekly: '전주 대비', monthly: '전월 대비' }[type] || '전기 대비');
    const currLabel = isCustom ? `당기 (${fmtRange(dateRange)})` : ({ weekly: '금주', monthly: '당월' }[type] || '당기');
    const prevCmpLabel = isCustom ? `전기 (${fmtRange(prevRange)})` : ({ weekly: '전주', monthly: '전월' }[type] || '전기');

    const cmp = wb.addWorksheet('기간비교');
    setup(cmp); setColWidths(cmp, [16, 10]);

    let r = 3;
    r = sectionTitle(cmp, r, `${cmpLabel} 성과 비교 (${period})`, 14);
    r++;

    // ── 전체 요약 비교 ──
    r = subTitle(cmp, r, '📊 전체 성과 비교', 14);
    {
      const hRow = cmp.getRow(r); hRow.height = 26;
      ['구분', '기간', ...mHeaders].forEach((h, i) => {
        const c = hRow.getCell(i + 2);
        c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
        c.alignment = cm; c.border = border;
      });
      r++;
      r = dataRow(cmp, r, data.total, { labels: ['전체', currLabel], bold: true });
      r = dataRow(cmp, r, prevData.total, { labels: ['전체', prevCmpLabel], stripe: true });
      {
        const row = cmp.getRow(r); row.height = 23;
        const lc1 = row.getCell(2); lc1.value = ''; lc1.border = border;
        const lc2 = row.getCell(3); lc2.value = cmpLabel; lc2.font = { size: 10, italic: true, color: { argb: C.gray } }; lc2.alignment = cm; lc2.border = border;
        const diffs = [data.total.cost-prevData.total.cost, data.total.imp-prevData.total.imp, (data.total.avgRank||0)-(prevData.total.avgRank||0), data.total.clk-prevData.total.clk, (data.total.cpc||0)-(prevData.total.cpc||0), (data.total.ctr||0)-(prevData.total.ctr||0), (data.total.purchaseCnt||0)-(prevData.total.purchaseCnt||0), (data.total.purchaseAmt||0)-(prevData.total.purchaseAmt||0), (data.total.roas||0)-(prevData.total.roas||0), (data.total.cartCnt||0)-(prevData.total.cartCnt||0), (data.total.cartAmt||0)-(prevData.total.cartAmt||0)];
        diffs.forEach((v, i) => {
          const c = row.getCell(4 + i); c.value = v; c.numFmt = mFmts[i];
          const costLike = [0, 4].includes(i);
          c.font = { size: 10, italic: true, color: { argb: v === 0 ? C.gray : ((v > 0) === costLike ? C.red : C.green) } };
          c.alignment = cm; c.border = border;
        });
        r++;
      }
    }
    r += 2;

    // ── 캠페인유형별 비교 ──
    const currCt = data.byCampaignType || {};
    const prevCt = prevData.byCampaignType || {};
    const allCtTypes = [...new Set([...Object.keys(currCt), ...Object.keys(prevCt)])];

    if (allCtTypes.length > 0) {
      r = subTitle(cmp, r, '📋 캠페인유형별 비교', 14);
      const hRow = cmp.getRow(r); hRow.height = 26;
      ['캠페인유형', '기간', ...mHeaders].forEach((h, i) => {
        const c = hRow.getCell(i + 2);
        c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
        c.alignment = cm; c.border = border;
      });
      r++;

      const emptyMetric = { cost: 0, imp: 0, clk: 0, cpc: 0, ctr: 0, avgRank: 0, purchaseCnt: 0, purchaseAmt: 0, roas: 0, cartCnt: 0, cartAmt: 0 };

      for (const tp of allCtTypes) {
        const curr = currCt[tp] || emptyMetric;
        const prev = prevCt[tp] || emptyMetric;

        r = dataRow(cmp, r, curr, { labels: [tp, currLabel], bold: true, labelColor: C.blue });
        r = dataRow(cmp, r, prev, { labels: [tp, prevCmpLabel], stripe: true });
        const diff = {};
        ['cost','imp','clk','cpc','ctr','avgRank','purchaseCnt','purchaseAmt','roas','cartCnt','cartAmt'].forEach(k => { diff[k] = (curr[k]||0) - (prev[k]||0); });
        {
          const row = cmp.getRow(r); row.height = 23;
          const lc1 = row.getCell(2); lc1.value = tp; lc1.font = { size: 10, italic: true, color: { argb: C.gray } }; lc1.alignment = cm; lc1.border = border;
          const lc2 = row.getCell(3); lc2.value = cmpLabel; lc2.font = { size: 10, italic: true, color: { argb: C.gray } }; lc2.alignment = cm; lc2.border = border;
          const diffs = [diff.cost, diff.imp, diff.avgRank, diff.clk, diff.cpc, diff.ctr, diff.purchaseCnt, diff.purchaseAmt, diff.roas, diff.cartCnt, diff.cartAmt];
          diffs.forEach((v, i) => {
            const c = row.getCell(4 + i); c.value = v; c.numFmt = mFmts[i];
            const costLike = [0, 4].includes(i);
            c.font = { size: 10, italic: true, color: { argb: v === 0 ? C.gray : ((v > 0) === costLike ? C.red : C.green) } };
            c.alignment = cm; c.border = border;
          });
          r++;
        }
        {
          const row = cmp.getRow(r); row.height = 20;
          const lc1 = row.getCell(2); lc1.value = ''; lc1.border = border;
          const lc2 = row.getCell(3); lc2.value = '증감률'; lc2.font = { size: 9, italic: true, color: { argb: C.gray } }; lc2.alignment = cm; lc2.border = border;
          const prevVals = [prev.cost||0, prev.imp||0, prev.avgRank||0, prev.clk||0, prev.cpc||0, prev.ctr||0, prev.purchaseCnt||0, prev.purchaseAmt||0, prev.roas||0, prev.cartCnt||0, prev.cartAmt||0];
          const currVals = [curr.cost||0, curr.imp||0, curr.avgRank||0, curr.clk||0, curr.cpc||0, curr.ctr||0, curr.purchaseCnt||0, curr.purchaseAmt||0, curr.roas||0, curr.cartCnt||0, curr.cartAmt||0];
          currVals.forEach((cv, i) => {
            const pv = prevVals[i];
            const pctChange = pv !== 0 ? ((cv - pv) / Math.abs(pv) * 100) : (cv > 0 ? 100 : 0);
            const c = row.getCell(4 + i);
            c.value = pctChange / 100; c.numFmt = '+0.0%;-0.0%;0.0%';
            const costLike = [0, 4].includes(i);
            c.font = { size: 9, italic: true, color: { argb: pctChange === 0 ? C.gray : ((pctChange > 0) === costLike ? C.red : C.green) } };
            c.alignment = cm; c.border = border;
          });
          r++;
        }
        r++;
      }
      r++;
    }

    // ── 광고그룹별 비교 ──
    const currAg = data.byAdgroup || {};
    const prevAgCmp = prevData.byAdgroup || {};
    const allAgIds = [...new Set([...Object.keys(currAg), ...Object.keys(prevAgCmp)])];
    const sortedAgIds = allAgIds.sort((a, b) => ((currAg[b]||{}).cost||0) - ((currAg[a]||{}).cost||0));

    if (sortedAgIds.length > 0) {
      r = subTitle(cmp, r, `📂 광고그룹별 비교 (Top 20, ${cmpLabel})`, 14);
      const hRow = cmp.getRow(r); hRow.height = 26;
      ['광고그룹', '기간', ...mHeaders].forEach((h, i) => {
        const c = hRow.getCell(i + 2);
        c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
        c.alignment = cm; c.border = border;
      });
      r++;

      const emptyMetric = { cost: 0, imp: 0, clk: 0, cpc: 0, ctr: 0, avgRank: 0, purchaseCnt: 0, purchaseAmt: 0, roas: 0, cartCnt: 0, cartAmt: 0 };
      const top20 = sortedAgIds.slice(0, 20);

      for (const agId of top20) {
        const curr = currAg[agId] || emptyMetric;
        const prev = prevAgCmp[agId] || emptyMetric;
        const agName = curr.name || prev.name || agId;

        r = dataRow(cmp, r, curr, { labels: [agName, currLabel], bold: true, labelColor: C.blue });
        r = dataRow(cmp, r, prev, { labels: [agName, prevCmpLabel], stripe: true });
        const diff = {};
        ['cost','imp','clk','cpc','ctr','avgRank','purchaseCnt','purchaseAmt','roas','cartCnt','cartAmt'].forEach(k => { diff[k] = (curr[k]||0) - (prev[k]||0); });
        {
          const row = cmp.getRow(r); row.height = 23;
          const lc1 = row.getCell(2); lc1.value = agName; lc1.font = { size: 10, italic: true, color: { argb: C.gray } }; lc1.alignment = cm; lc1.border = border;
          const lc2 = row.getCell(3); lc2.value = cmpLabel; lc2.font = { size: 10, italic: true, color: { argb: C.gray } }; lc2.alignment = cm; lc2.border = border;
          const diffs = [diff.cost, diff.imp, diff.avgRank, diff.clk, diff.cpc, diff.ctr, diff.purchaseCnt, diff.purchaseAmt, diff.roas, diff.cartCnt, diff.cartAmt];
          diffs.forEach((v, i) => {
            const c = row.getCell(4 + i); c.value = v; c.numFmt = mFmts[i];
            const costLike = [0, 4].includes(i);
            c.font = { size: 10, italic: true, color: { argb: v === 0 ? C.gray : ((v > 0) === costLike ? C.red : C.green) } };
            c.alignment = cm; c.border = border;
          });
          r++;
        }
        {
          const row = cmp.getRow(r); row.height = 20;
          const lc1 = row.getCell(2); lc1.value = ''; lc1.border = border;
          const lc2 = row.getCell(3); lc2.value = '증감률'; lc2.font = { size: 9, italic: true, color: { argb: C.gray } }; lc2.alignment = cm; lc2.border = border;
          const prevVals = [prev.cost||0, prev.imp||0, prev.avgRank||0, prev.clk||0, prev.cpc||0, prev.ctr||0, prev.purchaseCnt||0, prev.purchaseAmt||0, prev.roas||0, prev.cartCnt||0, prev.cartAmt||0];
          const currVals = [curr.cost||0, curr.imp||0, curr.avgRank||0, curr.clk||0, curr.cpc||0, curr.ctr||0, curr.purchaseCnt||0, curr.purchaseAmt||0, curr.roas||0, curr.cartCnt||0, curr.cartAmt||0];
          currVals.forEach((cv, i) => {
            const pv = prevVals[i];
            const pctChange = pv !== 0 ? ((cv - pv) / Math.abs(pv) * 100) : (cv > 0 ? 100 : 0);
            const c = row.getCell(4 + i);
            c.value = pctChange / 100; c.numFmt = '+0.0%;-0.0%;0.0%';
            const costLike = [0, 4].includes(i);
            c.font = { size: 9, italic: true, color: { argb: pctChange === 0 ? C.gray : ((pctChange > 0) === costLike ? C.red : C.green) } };
            c.alignment = cm; c.border = border;
          });
          r++;
        }
        r++;
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 3. 유형 및 기기별 (캠페인유형 + PC/모바일 합침)
  // ══════════════════════════════════════════════════════════════════
  {
    const cts = wb.addWorksheet('유형 및 기기별');
    setup(cts); setColWidths(cts, [18]);

    let r = 3;
    r = sectionTitle(cts, r, `캠페인 유형 및 기기별 성과 (${period})`);
    r++;

    // ── 캠페인 유형별 ──
    const emptyMetric = { cost: 0, imp: 0, clk: 0, cpc: 0, ctr: 0, avgRank: 0, purchaseCnt: 0, purchaseAmt: 0, roas: 0, cartCnt: 0, cartAmt: 0 };
    const ctMap = data.byCampaignType || {};
    // 필수 유형 보장: 파워링크, 쇼핑검색, 브랜드검색, 파워콘텐츠
    const requiredTypes = ['파워링크', '쇼핑검색', '브랜드검색', '파워콘텐츠'];
    for (const tp of requiredTypes) {
      if (!ctMap[tp]) ctMap[tp] = { ...emptyMetric };
    }
    const ctEntries = Object.entries(ctMap).sort((a, b) => b[1].cost - a[1].cost);

    // 비율 요약
    const totalCost = ctEntries.reduce((s, [, d]) => s + (d.cost||0), 0) || 1;
    const sRow = cts.getRow(r); sRow.height = 30;
    const colsPerType = Math.max(4, Math.floor(12 / (ctEntries.length || 1)));
    ctEntries.forEach(([tp, d], i) => {
      const pct = Math.round(d.cost / totalCost * 100);
      const startCol = 2 + i * colsPerType;
      const endCol = startCol + colsPerType - 1;
      if (endCol > startCol) cts.mergeCells(r, startCol, r, endCol);
      const c = sRow.getCell(startCol);
      c.value = `${tp} — 비용 ${pct}% (${f.won(d.cost)})`;
      c.font = { bold: true, size: 11, color: { argb: C.blue } };
      c.alignment = cm; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.border = border;
      for (let cc = startCol + 1; cc <= endCol; cc++) { sRow.getCell(cc).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; sRow.getCell(cc).border = border; }
    });
    r += 2;

    r = subTitle(cts, r, '캠페인 유형별 성과', 13);
    r = tableHeader(cts, r, ['캠페인 유형']);
    ctEntries.forEach(([tp, d], idx) => {
      r = dataRow(cts, r, d, { labels: [tp], stripe: idx % 2 === 1, bold: true });
    });
    r++;
    r = dataRow(cts, r, data.total, { labels: ['합계'], bold: true, bg: C.totalBg });
    r += 3;

    // ── PC / 모바일 ──
    const devEntries = Object.entries(data.byDevice || {}).sort((a, b) => b[1].cost - a[1].cost);
    if (devEntries.length > 0) {
      const totalDevCost = devEntries.reduce((s, [, d]) => s + (d.cost||0), 0) || 1;
      const totalDevClk = devEntries.reduce((s, [, d]) => s + (d.clk||0), 0) || 1;
      const devSRow = cts.getRow(r); devSRow.height = 28;
      const devColsPerType = Math.max(4, Math.floor(12 / (devEntries.length || 1)));
      devEntries.forEach(([dev, d], i) => {
        const startCol = 2 + i * devColsPerType;
        const endCol = startCol + devColsPerType - 1;
        if (endCol > startCol) cts.mergeCells(r, startCol, r, endCol);
        const c = devSRow.getCell(startCol);
        c.value = `${dev === 'PC' ? '🖥 PC' : '📱 MO'} — 비용 ${Math.round(d.cost/totalDevCost*100)}% · 클릭 ${Math.round(d.clk/totalDevClk*100)}%`;
        c.font = { bold: true, size: 11, color: { argb: dev === 'PC' ? C.blue : 'FFF97316' } };
        c.alignment = cm; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.border = border;
        for (let cc = startCol + 1; cc <= endCol; cc++) { devSRow.getCell(cc).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; devSRow.getCell(cc).border = border; }
      });
      r += 2;

      r = subTitle(cts, r, 'PC / 모바일 성과', 13);
      r = tableHeader(cts, r, ['디바이스']);
      devEntries.forEach(([dev, d], idx) => { r = dataRow(cts, r, d, { labels: [dev], stripe: idx % 2 === 1 }); });
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 4. 광고그룹별
  // ══════════════════════════════════════════════════════════════════
  const agEntries = Object.entries(data.byAdgroup).sort((a, b) => b[1].cost - a[1].cost);
  if (agEntries.length > 0) {
    const gs = wb.addWorksheet('광고그룹별');
    setup(gs); setColWidths(gs, [20, 25]);

    let r = 3;
    r = sectionTitle(gs, r, `광고그룹별 성과 현황 (${period})`, 14);
    r++;

    const hRow = gs.getRow(r); hRow.height = 26;
    ['캠페인', '광고그룹', ...mHeaders].forEach((h, i) => {
      const c = hRow.getCell(i + 2);
      c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
      c.alignment = cm; c.border = border;
    });
    r++;

    agEntries.forEach(([, d], idx) => {
      const top10 = idx < 10;
      r = dataRow(gs, r, d, { labels: [d.campaignName || '', (top10 ? `★ ${idx+1}. ` : '') + d.name], stripe: idx % 2 === 1, bold: top10, labelColor: top10 ? C.blue : undefined });
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 5. 검색어별 (캠페인 유형별 시트 분리)
  // AD_QUERY_DETAIL 기반(byQuery)을 우선 사용 — 마스터 sync 의존도 0
  // (대용량 계정에서 마스터 동기화가 불완전해도 검색어 텍스트가 항상 표시됨)
  // byQuery 데이터가 없을 때만 등록 키워드(byKeyword) 폴백
  // ══════════════════════════════════════════════════════════════════
  const useQuery = data.byQuery && Object.keys(data.byQuery).length > 0
    && Object.values(data.byQuery).some(d => (d.cost || 0) > 0 || (d.clk || 0) > 0);
  const kwSource = useQuery ? data.byQuery : (data.byKeyword || {});
  const kwLabel = useQuery ? '검색어별' : '키워드별';
  const kwAll = Object.entries(kwSource).sort((a, b) => b[1].cost - a[1].cost);
  if (kwAll.length > 0) {
    // 캠페인 유형별 그룹화 (cost 합계 0이면 시트 미생성)
    const typeGroups = {};
    kwAll.forEach(([id, d]) => {
      const tp = d.campaignType || '기타';
      if (!typeGroups[tp]) typeGroups[tp] = [];
      typeGroups[tp].push([id, d]);
    });

    // 시트 생성 순서 우선: 파워링크 → 쇼핑검색 → 브랜드검색 → 파워콘텐츠 → 기타
    const typeOrder = ['파워링크', '쇼핑검색', '브랜드검색', '파워콘텐츠', '로컬', '기타'];
    const sortedTypes = Object.keys(typeGroups).sort((a, b) => {
      const ai = typeOrder.indexOf(a); const bi = typeOrder.indexOf(b);
      return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });

    function kwHeader(ws, row) {
      const hRow = ws.getRow(row); hRow.height = 26;
      ['광고그룹', useQuery ? '검색어' : '키워드', ...mHeaders].forEach((h, i) => {
        const c = hRow.getCell(i + 2);
        c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
        c.alignment = cm; c.border = border;
      });
      return row + 1;
    }
    function kwRow(ws, row, d, opts = {}) {
      return dataRow(ws, row, d, { ...opts, labels: [d.adgroupName || '', d.name || '(미인식)'] });
    }

    sortedTypes.forEach(tp => {
      const list = typeGroups[tp];
      // 데이터 0이면 시트 미생성 (cost 합계 0)
      const totalCost = list.reduce((s, [, d]) => s + (d.cost || 0), 0);
      if (totalCost <= 0) return;

      const sheetName = `${tp}_${kwLabel}`.slice(0, 31); // Excel 시트명 31자 제한
      const kws = wb.addWorksheet(sheetName);
      setup(kws); setColWidths(kws, [22, 24]);

      // 미인식 키워드 패턴: 마스터 sync 누락으로 ID가 그대로 노출된 경우
      // nkw-... (NCC 키워드 ID), ncc-..., nad-... 등 + '-' (쇼핑검색 등 미인식)
      // useQuery=true (AD_QUERY_DETAIL 기반)면 항상 텍스트이므로 미인식 판정 X
      const UNRESOLVED_RE = /^(nkw|ncc|nad|nccad)[-_]/i;
      const isUnresolved = (d) => {
        if (useQuery) return false;
        if (!d.name || d.name === '-') return true;
        if (UNRESOLVED_RE.test(d.name)) return true;
        return false;
      };
      const validKw = list.filter(([, d]) => !isUnresolved(d));
      const unknownKw = list.filter(([, d]) => isUnresolved(d));
      const kwWithConv = validKw.filter(([, d]) => d.purchaseCnt > 0).length;

      let r = 3;
      r = sectionTitle(kws, r, `${tp} · ${kwLabel} 성과 (${period})`, 14);
      r++;
      r = subTitle(kws, r, useQuery
        ? `전체 검색어 ${list.length}개 · 전환 발생 ${kwWithConv}개 (AD_QUERY_DETAIL 기반)`
        : `전체 ${list.length}개 · 인식 ${validKw.length}개 · 전환 발생 ${kwWithConv}개${unknownKw.length ? ' · 미인식 '+unknownKw.length+'개' : ''}`, 14);
      r++;

      // ── 구매전환매출 TOP 10 ──
      const convTop = [...validKw].filter(([, d]) => d.purchaseAmt > 0).sort((a, b) => b[1].purchaseAmt - a[1].purchaseAmt).slice(0, 10);
      if (convTop.length > 0) {
        r = subTitle(kws, r, '★ 구매전환매출 TOP 10', 14);
        r = kwHeader(kws, r);
        convTop.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, bold: idx < 3, labelColor: idx < 3 ? C.green : undefined }); });
        r += 2;
      }
      // ── 클릭 TOP 10 ──
      const clkTop = [...validKw].sort((a, b) => b[1].clk - a[1].clk).slice(0, 10);
      if (clkTop.length > 0 && clkTop[0][1].clk > 0) {
        r = subTitle(kws, r, '★ 클릭 TOP 10', 14);
        r = kwHeader(kws, r);
        clkTop.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, bold: idx < 3, labelColor: idx < 3 ? C.blue : undefined }); });
        r += 2;
      }
      // ── ROAS TOP 10 ──
      const roasTop = [...validKw].filter(([, d]) => d.clk >= 5 && d.roas > 0).sort((a, b) => b[1].roas - a[1].roas).slice(0, 10);
      if (roasTop.length > 0) {
        r = subTitle(kws, r, '★ ROAS TOP 10 (5클릭 이상)', 14);
        r = kwHeader(kws, r);
        roasTop.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, bold: idx < 3, labelColor: idx < 3 ? C.green : undefined }); });
        r += 2;
      }
      // ── 비효율 키워드 ──
      const wasteful = validKw.filter(([, d]) => d.cost > 0 && d.purchaseCnt === 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
      if (wasteful.length > 0) {
        r = subTitle(kws, r, '⚠ 비효율 키워드 (비용 발생, 전환 없음) TOP 10', 14);
        r = kwHeader(kws, r);
        wasteful.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, labelColor: C.red }); });
        r += 2;
      }
      // ── 전체 키워드 (성능 가드: 200개 초과 시 TOP 200만) ──
      const KW_LIST_CAP = 200;
      const showAllKw = validKw.length > KW_LIST_CAP ? validKw.slice(0, KW_LIST_CAP) : validKw;
      const truncated = validKw.length > KW_LIST_CAP;
      r = subTitle(kws, r, truncated
        ? `전체 키워드 목록 (총 ${validKw.length}개 중 비용 상위 ${KW_LIST_CAP}개만 표시 — 메모리 보호)`
        : `전체 키워드 목록 (${validKw.length}개, 비용순)`, 14);
      r = kwHeader(kws, r);
      showAllKw.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1 }); });
      if (unknownKw.length > 0) {
        r += 2;
        const showUnknown = unknownKw.length > KW_LIST_CAP ? unknownKw.slice(0, KW_LIST_CAP) : unknownKw;
        r = subTitle(kws, r, unknownKw.length > KW_LIST_CAP
          ? `미인식 키워드 ⚠ (총 ${unknownKw.length}개 중 비용 상위 ${KW_LIST_CAP}개 — 삭제된 키워드/확장검색/마스터 누락)`
          : `미인식 키워드 ⚠ ${unknownKw.length}개 (삭제된 키워드/확장검색/마스터 누락)`, 14);
        r = kwHeader(kws, r);
        showUnknown.forEach(([k, d], idx) => {
          // 키워드 컬럼에 '(미인식) ID끝부분' 표시
          const kwId = (k || '').replace(/^kw:/, '');
          const shortId = kwId.length > 14 ? '...' + kwId.slice(-12) : kwId;
          const labelOverride = { ...d, name: `(미인식) ${shortId}` };
          r = dataRow(kws, r, labelOverride, { labels: [d.adgroupName || '', `(미인식) ${shortId}`], stripe: idx % 2 === 1, labelColor: C.gray });
        });
      }
    });
  }

  // PC/모바일은 "유형 및 기기별" 시트에 합침 (별도 시트 제거)

  // ══════════════════════════════════════════════════════════════════
  // 7. 시간대별 (구매전환매출 기준)
  // ══════════════════════════════════════════════════════════════════
  const hourEntries = Object.entries(data.byHour).sort((a, b) => a[0].localeCompare(b[0]));
  if (hourEntries.length > 0) {
    const hs = wb.addWorksheet('시간대별');
    setup(hs); setColWidths(hs, [10]);
    let r = 3;
    r = sectionTitle(hs, r, `시간대별 성과 분포 (${period})`);
    r++;

    // 구매전환매출 히트맵
    const maxAmt = Math.max(...hourEntries.map(([, d]) => d.purchaseAmt || 0), 1);
    const topHours = [...hourEntries].sort((a, b) => (b[1].purchaseAmt||0) - (a[1].purchaseAmt||0)).slice(0, 3);
    const topKeys = topHours.map(([h]) => h);

    r = subTitle(hs, r, '시간대별 구매전환매출 히트맵 (진할수록 높음)', 13);
    const heatRow = hs.getRow(r); heatRow.height = 30;
    for (let h = 0; h < Math.min(24, 12); h++) {
      const hKey = String(h).padStart(2, '0');
      const d = data.byHour[hKey];
      const amt = d ? (d.purchaseAmt || 0) : 0;
      const intensity = Math.round(amt / maxAmt * 200);
      const cell = heatRow.getCell(h + 2);
      cell.value = amt; cell.numFmt = FMT.won;
      cell.font = { size: 8, bold: topKeys.includes(hKey), color: { argb: intensity > 100 ? C.white : C.dark } };
      cell.alignment = cm; cell.border = border;
      const g = Math.max(0, 200 - intensity);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${Math.min(50+intensity,255).toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${Math.min(100+intensity,255).toString(16).padStart(2,'0')}` } };
    }
    r++;
    const hLbl = hs.getRow(r);
    for (let h = 0; h < 12; h++) { const c = hLbl.getCell(h + 2); c.value = `${h}시`; c.font = { size: 8, color: { argb: C.gray } }; c.alignment = cm; }
    r++;

    const heatRow2 = hs.getRow(r); heatRow2.height = 30;
    for (let h = 12; h < 24; h++) {
      const hKey = String(h).padStart(2, '0');
      const d = data.byHour[hKey];
      const amt = d ? (d.purchaseAmt || 0) : 0;
      const intensity = Math.round(amt / maxAmt * 200);
      const cell = heatRow2.getCell(h - 12 + 2);
      cell.value = amt; cell.numFmt = FMT.won;
      cell.font = { size: 8, bold: topKeys.includes(hKey), color: { argb: intensity > 100 ? C.white : C.dark } };
      cell.alignment = cm; cell.border = border;
      const g = Math.max(0, 200 - intensity);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${Math.min(50+intensity,255).toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${Math.min(100+intensity,255).toString(16).padStart(2,'0')}` } };
    }
    r++;
    const hLbl2 = hs.getRow(r);
    for (let h = 12; h < 24; h++) { const c = hLbl2.getCell(h - 12 + 2); c.value = `${h}시`; c.font = { size: 8, color: { argb: C.gray } }; c.alignment = cm; }
    r += 2;

    r = subTitle(hs, r, `구매전환 최대 시간대: ${topHours.map(([h, d]) => `${parseInt(h)}시(${f.won(d.purchaseAmt||0)})`).join(', ')}`, 13);
    r++;

    r = tableHeader(hs, r, ['시간']);
    hourEntries.forEach(([h, d], idx) => {
      const isTop = topKeys.includes(h);
      r = dataRow(hs, r, d, { labels: [`${parseInt(h)}시`], stripe: idx % 2 === 1, bold: isTop, labelColor: isTop ? C.green : undefined });
    });
  }

  // ══════════════════════════════════════════════════════════════════
  // 8. 일자별
  // ══════════════════════════════════════════════════════════════════
  const dateEntries = Object.entries(data.byDate).sort((a, b) => a[0].localeCompare(b[0]));
  if (dateEntries.length > 1) {
    const dts = wb.addWorksheet('일자별');
    setup(dts); setColWidths(dts, [18]);
    let r = 3;
    r = sectionTitle(dts, r, `일자별 성과 추이 (${period})`);
    r++;

    // 일자별 비용 바
    const maxCost = Math.max(...dateEntries.map(([, d]) => d.cost), 1);
    r = subTitle(dts, r, '일자별 비용 분포', 13);
    dateEntries.forEach(([dt, d]) => {
      const dayOfWeek = ['일','월','화','수','목','금','토'][new Date(dt).getDay()];
      const row = dts.getRow(r); row.height = 18;
      const lc = row.getCell(2); lc.value = `${dt.slice(5)} (${dayOfWeek})`;
      lc.font = { size: 9, color: { argb: C.gray } }; lc.alignment = cm; lc.border = border;
      const bc = row.getCell(3); bc.value = '█'.repeat(Math.max(1, Math.round(d.cost/maxCost*30))) + ` ${f.won(d.cost)}`;
      bc.font = { size: 9, color: { argb: C.purple } }; bc.alignment = { horizontal: 'left', vertical: 'middle' }; bc.border = border;
      r++;
    });
    r += 2;

    r = tableHeader(dts, r, ['일자']);
    dateEntries.forEach(([dt, d], idx) => {
      const dayOfWeek = ['일','월','화','수','목','금','토'][new Date(dt).getDay()];
      const isWeekend = [0, 6].includes(new Date(dt).getDay());
      r = dataRow(dts, r, d, { labels: [`${dt} (${dayOfWeek})`], stripe: idx % 2 === 1, labelColor: isWeekend ? C.red : undefined });
    });

    // 합계
    r++;
    const dtTotal = { cost: 0, imp: 0, clk: 0, cpc: 0, ctr: 0, avgRank: 0, purchaseCnt: 0, purchaseAmt: 0, roas: 0, cartCnt: 0, cartAmt: 0 };
    let rankSum = 0, rankCount = 0;
    dateEntries.forEach(([, d]) => { dtTotal.cost += d.cost||0; dtTotal.imp += d.imp||0; dtTotal.clk += d.clk||0; dtTotal.purchaseCnt += d.purchaseCnt||0; dtTotal.purchaseAmt += d.purchaseAmt||0; dtTotal.cartCnt += d.cartCnt||0; dtTotal.cartAmt += d.cartAmt||0; if (d.avgRank > 0 && d.imp > 0) { rankSum += d.avgRank * d.imp; rankCount += d.imp; } });
    dtTotal.cpc = dtTotal.clk > 0 ? Math.round(dtTotal.cost / dtTotal.clk) : 0;
    dtTotal.ctr = dtTotal.imp > 0 ? (dtTotal.clk / dtTotal.imp * 100) : 0;
    dtTotal.avgRank = rankCount > 0 ? (rankSum / rankCount) : 0;
    dtTotal.roas = dtTotal.cost > 0 ? Math.round(dtTotal.purchaseAmt / dtTotal.cost * 100) : 0;
    r = dataRow(dts, r, dtTotal, { labels: ['합계'], bold: true, bg: C.totalBg });
  }

  // 기간비교는 요약·캠페인 바로 다음(section 2-1)으로 이동 완료

  // ══════════════════════════════════════════════════════════════════
  // 9. 시트 on/off — 비활성 표준 시트 제거 (표지·요약은 항상 유지)
  // ══════════════════════════════════════════════════════════════════
  const STD_SHEET_NAMES = {
    summary: ['요약·캠페인'],
    comparison: ['기간비교'],
    typeDevice: ['유형 및 기기별'],
    adgroup: ['광고그룹별'],
    hourly: ['시간대별'],
    daily: ['일자별'],
  };
  const toRemove = [];
  for (const [k, names] of Object.entries(STD_SHEET_NAMES)) {
    if (k === 'summary') continue; // 요약은 항상 유지
    if (!sheetOn(k)) names.forEach(n => { const ws = wb.getWorksheet(n); if (ws) toRemove.push(ws.id); });
  }
  if (!sheetOn('keyword')) {
    wb.worksheets.filter(ws => /_(검색어별|키워드별)$/.test(ws.name)).forEach(ws => toRemove.push(ws.id));
  }
  toRemove.forEach(id => { try { wb.removeWorksheet(id); } catch (_) {} });

  // ══════════════════════════════════════════════════════════════════
  // 10. 커스텀 시트 (차원 + 지표 선택)
  // ══════════════════════════════════════════════════════════════════
  const usedNames = new Set(wb.worksheets.map(w => w.name));
  function uniqueName(base) {
    let n = String(base || '맞춤').slice(0, 31); let i = 2;
    while (usedNames.has(n)) { const suf = ' (' + i + ')'; n = String(base).slice(0, 31 - suf.length) + suf; i++; }
    usedNames.add(n); return n;
  }
  function buildCustomSheet(def) {
    const dim = DIMENSION_DEFS[def.dimension]; if (!dim) return;
    const src = data[def.dimension] || {};
    const selKeys = (Array.isArray(def.metrics) && def.metrics.length) ? def.metrics : METRIC_DEFS.map(m => m.key);
    const cols = METRIC_DEFS.filter(m => selKeys.includes(m.key));
    if (cols.length === 0) return;
    const sortKey = (def.sortBy && cols.some(c => c.key === def.sortBy)) ? def.sortBy : cols[0].key;
    let entries = Object.entries(src).filter(([, d]) => ((d.imp || 0) + (d.clk || 0) + (d.cost || 0)) > 0);
    if (def.dimension === 'byDate' || def.dimension === 'byHour') entries.sort((a, b) => a[0].localeCompare(b[0]));
    else entries.sort((a, b) => (b[1][sortKey] || 0) - (a[1][sortKey] || 0));
    const limit = (def.limit && def.limit > 0) ? def.limit : 200;
    const truncated = entries.length > limit;
    if (truncated) entries = entries.slice(0, limit);
    const ws = wb.addWorksheet(uniqueName(def.name || (dim.label + ' 맞춤')));
    setup(ws);
    dim.labelHeaders.forEach((h, i) => ws.getColumn(i + 2).width = (i === dim.labelHeaders.length - 1 ? 26 : 20));
    cols.forEach((c, i) => ws.getColumn(2 + dim.labelHeaders.length + i).width = 13);
    const span = 1 + dim.labelHeaders.length + cols.length;
    let r = 3;
    r = sectionTitle(ws, r, (def.name || dim.label + ' 맞춤') + ` (${period})`, span);
    r++;
    r = subTitle(ws, r, `${dim.label} 기준 · ${cols.map(c => c.label).join(', ')}${truncated ? ` · 상위 ${limit}개` : ''}`, span);
    r++;
    const hRow = ws.getRow(r); hRow.height = 26;
    [...dim.labelHeaders, ...cols.map(c => c.label)].forEach((h, i) => {
      const c = hRow.getCell(i + 2); c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.alignment = cm; c.border = border;
    });
    r++;
    if (entries.length === 0) { const c = ws.getRow(r).getCell(2); c.value = '데이터 없음'; c.font = { size: 10, color: { argb: C.gray } }; c.border = border; return; }
    entries.forEach(([k, d], idx) => {
      const row = ws.getRow(r); row.height = 22;
      const labels = dim.labels(d, k);
      labels.forEach((lb, li) => { const c = row.getCell(2 + li); c.value = lb; c.font = { size: 10, color: { argb: C.dark } }; c.alignment = cm; c.border = border; if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } }; });
      cols.forEach((mc, ci) => { const c = row.getCell(2 + labels.length + ci); c.value = d[mc.key] || 0; c.numFmt = mc.fmt; c.font = { size: 10, color: { argb: C.gray } }; c.alignment = cm; c.border = border; if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } }; });
      r++;
    });
  }
  (cfg.customSheets || []).forEach(def => { try { buildCustomSheet(def); } catch (e) { console.log('커스텀 시트 실패:', e.message); } });

  // ══════════════════════════════════════════════════════════════════
  // 11. 원클릭 계정분석 제안 시트 (suggestions 전달 시)
  // ══════════════════════════════════════════════════════════════════
  if (suggestions) {
    function buildBidSuggestionSheet(name, items, accent, introLines) {
      const ws = wb.addWorksheet(uniqueName(name)); setup(ws);
      [22, 22, 24, 11, 10, 9, 13, 11, 10, 10, 9, 15, 22, 46].forEach((w, i) => ws.getColumn(i + 2).width = w);
      let r = 3;
      r = sectionTitle(ws, r, name + ` (${period})`, 15); r++;
      introLines.forEach(line => { r = subTitle(ws, r, line, 15); }); r++;
      const headers = ['캠페인', '광고그룹', '키워드', '노출수', '클릭수', 'CTR', '총비용', 'CPC', '평균순위', 'ROAS', '구매수', '구매매출', '추천 액션', '근거'];
      const hRow = ws.getRow(r); hRow.height = 26;
      headers.forEach((h, i) => { const c = hRow.getCell(i + 2); c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.alignment = cm; c.border = border; });
      r++;
      if (!items.length) { const c = ws.getRow(r).getCell(2); ws.mergeCells(r, 2, r, 15); c.value = '해당 조건의 제안이 없습니다.'; c.font = { size: 10, color: { argb: C.gray } }; c.alignment = { horizontal: 'left', vertical: 'middle' }; c.border = border; return; }
      const fmts = [null, null, null, FMT.num, FMT.num, FMT.pct, FMT.won, FMT.won, FMT.rank, FMT.roas, FMT.num, FMT.won, null, null];
      items.forEach((it, idx) => {
        const row = ws.getRow(r); row.height = 24;
        const vals = [it.campaignName || '', it.adgroupName || '', it.name || '', it.imp || 0, it.clk || 0, it.ctr || 0, it.cost || 0, it.cpc || 0, it.avgRank || 0, it.roas || 0, it.purchaseCnt || 0, it.purchaseAmt || 0, it.action || '', it.reason || ''];
        vals.forEach((v, i) => {
          const c = row.getCell(i + 2); c.value = v; if (fmts[i]) c.numFmt = fmts[i];
          const isAction = i === 12;
          c.font = { size: 9, bold: isAction, color: { argb: isAction ? accent : (i < 3 ? C.dark : C.gray) } };
          c.alignment = (i === 13 || i === 2) ? { horizontal: 'left', vertical: 'middle', wrapText: true } : cm;
          c.border = border; if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
        });
        r++;
      });
    }
    function buildDiscoverySheet(name, items) {
      const ws = wb.addWorksheet(uniqueName(name)); setup(ws);
      [30, 14, 13, 11, 11, 10, 11, 11, 20, 46].forEach((w, i) => ws.getColumn(i + 2).width = w);
      let r = 3;
      r = sectionTitle(ws, r, name + ` (${period})`, 11); r++;
      r = subTitle(ws, r, '① 전환 발생 미등록 검색어  ②키워드도구 연관 키워드(월 검색량 포함)', 11); r++;
      const headers = ['발굴 키워드', '출처', '월검색량', 'PC', '모바일', '경쟁', '현재클릭', '현재구매', '추천 액션', '근거'];
      const hRow = ws.getRow(r); hRow.height = 26;
      headers.forEach((h, i) => { const c = hRow.getCell(i + 2); c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } }; c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } }; c.alignment = cm; c.border = border; });
      r++;
      if (!items.length) { const c = ws.getRow(r).getCell(2); ws.mergeCells(r, 2, r, 11); c.value = '발굴된 키워드가 없습니다.'; c.font = { size: 10, color: { argb: C.gray } }; c.alignment = { horizontal: 'left', vertical: 'middle' }; c.border = border; return; }
      const fmts = [null, null, FMT.num, FMT.num, FMT.num, null, FMT.num, FMT.num, null, null];
      items.forEach((it, idx) => {
        const row = ws.getRow(r); row.height = 24;
        const isTool = it.source === '키워드도구';
        const vals = [it.keyword || '', it.source || '', it.monthlyTotal, it.monthlyPc, it.monthlyMobile, it.compIdx || '', it.currentClk || 0, it.currentPurchase || 0, it.action || '', it.reason || ''];
        vals.forEach((v, i) => {
          const c = row.getCell(i + 2); c.value = (v == null ? '-' : v); if (fmts[i] && v != null) c.numFmt = fmts[i];
          const srcCol = i === 1;
          c.font = { size: 9, bold: i === 0, color: { argb: i === 0 ? C.dark : (srcCol ? (isTool ? C.purple : C.green) : C.gray) } };
          c.alignment = (i === 0 || i === 9) ? { horizontal: 'left', vertical: 'middle', wrapText: true } : cm;
          c.border = border; if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
        });
        r++;
      });
    }
    buildBidSuggestionSheet('증액 제안', suggestions.upsell || [], C.green, ['성과 우수 · 노출/순위 여력 → 입찰·예산 증액 추천', `대상 ${(suggestions.upsell || []).length}건`]);
    buildBidSuggestionSheet('감액 제안', suggestions.downsell || [], C.red, ['비용 발생 대비 전환 없음/저효율 → 입찰 하향·OFF 추천', `대상 ${(suggestions.downsell || []).length}건`]);
    buildDiscoverySheet('키워드 발굴', suggestions.expansion || []);
  }

  return await wb.xlsx.writeBuffer();
}

module.exports = { buildExcelReport };
