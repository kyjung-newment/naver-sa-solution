const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');

// 포맷 헬퍼
const f = {
  num: n => Number(n || 0).toLocaleString('ko-KR'),
  won: n => `₩${Number(n || 0).toLocaleString('ko-KR')}`,
};

async function buildExcelReport({ type, period, accountName, data, prevData, demographics }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '뉴먼트 솔루션';
  wb.created = new Date();

  const typeLabel = { daily: '일간', weekly: '주간', monthly: '월간' }[type] || type;
  const diffLabel = { daily: '전일 대비', weekly: '전주 대비', monthly: '전월 대비' }[type] || '전기 대비';
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
  sheetList.push(['유형 및 기기별','캠페인유형별 + PC/모바일 성과'], ['광고그룹별','광고그룹별 성과 (TOP 10)'], ['키워드별','키워드별 전환/ROAS/비효율 TOP'], ['시간대별','구매전환매출 기준 시간대 분포'], ['일자별','일자별 성과 추이']);
  if (demographics && (demographics.gender?.length || demographics.age?.length)) sheetList.push(['성별·연령대','성별/연령대별 성과 분석']);
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
  if (prevData && type !== 'daily') {
    const cmpLabel = { weekly: '전주 대비', monthly: '전월 대비' }[type] || '전기 대비';
    const currLabel = { weekly: '금주', monthly: '당월' }[type] || '당기';
    const prevCmpLabel = { weekly: '전주', monthly: '전월' }[type] || '전기';

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
      r = diffRow(cmp, r, cmpLabel, data.total, prevData.total);
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
    // 필수 유형 보장: 쇼핑검색, 파워링크, 브랜드검색
    const requiredTypes = ['쇼핑검색', '파워링크', '브랜드검색'];
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
  // 5. 키워드별
  // ══════════════════════════════════════════════════════════════════
  const kwEntries = Object.entries(data.byKeyword || {}).sort((a, b) => b[1].cost - a[1].cost);
  if (kwEntries.length > 0) {
    const kws = wb.addWorksheet('키워드별');
    setup(kws); setColWidths(kws, [14, 20, 22]);

    // '-' 키워드 필터 (쇼핑검색은 키워드 인식 불가)
    const validKw = kwEntries.filter(([, d]) => d.name && d.name !== '-' && !d.name.match(/^ncc/));
    const unknownKw = kwEntries.filter(([, d]) => !d.name || d.name === '-' || d.name.match(/^ncc/));
    const kwCount = kwEntries.length;
    const validCount = validKw.length;
    const kwWithConv = validKw.filter(([, d]) => d.purchaseCnt > 0).length;

    let r = 3;
    r = sectionTitle(kws, r, `키워드별 성과 현황 (${period})`, 15);
    r++;
    r = subTitle(kws, r, `전체 ${kwCount}개 · 인식 ${validCount}개 · 전환 발생 ${kwWithConv}개 · 미인식(쇼핑검색 등) ${unknownKw.length}개`, 15);
    r++;

    // 키워드 헤더 함수: 캠페인유형/광고그룹/키워드
    function kwHeader(ws, row) {
      const hRow = ws.getRow(row); hRow.height = 26;
      ['캠페인유형', '광고그룹', '키워드', ...mHeaders].forEach((h, i) => {
        const c = hRow.getCell(i + 2);
        c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
        c.alignment = cm; c.border = border;
      });
      return row + 1;
    }

    function kwRow(ws, row, d, opts = {}) {
      return dataRow(ws, row, d, { ...opts, labels: [d.campaignType || '', d.adgroupName || '', d.name || '(미인식)'] });
    }

    // ── 구매전환 TOP 10 ──
    const convTop = [...validKw].filter(([, d]) => d.purchaseAmt > 0).sort((a, b) => b[1].purchaseAmt - a[1].purchaseAmt).slice(0, 10);
    if (convTop.length > 0) {
      r = subTitle(kws, r, '★ 구매전환매출 TOP 10 키워드', 15);
      r = kwHeader(kws, r);
      convTop.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, bold: idx < 3, labelColor: idx < 3 ? C.green : undefined }); });
      r += 2;
    }

    // ── 클릭 TOP 10 ──
    const clkTop = [...validKw].sort((a, b) => b[1].clk - a[1].clk).slice(0, 10);
    if (clkTop.length > 0) {
      r = subTitle(kws, r, '★ 클릭 TOP 10 키워드', 15);
      r = kwHeader(kws, r);
      clkTop.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, bold: idx < 3, labelColor: idx < 3 ? C.blue : undefined }); });
      r += 2;
    }

    // ── ROAS TOP 10 ──
    const roasTop = [...validKw].filter(([, d]) => d.clk >= 5 && d.roas > 0).sort((a, b) => b[1].roas - a[1].roas).slice(0, 10);
    if (roasTop.length > 0) {
      r = subTitle(kws, r, '★ ROAS TOP 10 키워드 (5클릭 이상)', 15);
      r = kwHeader(kws, r);
      roasTop.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, bold: idx < 3, labelColor: idx < 3 ? C.green : undefined }); });
      r += 2;
    }

    // ── 비효율 키워드 ──
    const wasteful = validKw.filter(([, d]) => d.cost > 0 && d.purchaseCnt === 0).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
    if (wasteful.length > 0) {
      r = subTitle(kws, r, '⚠ 비효율 키워드 (비용 발생, 전환 없음) TOP 10', 15);
      r = kwHeader(kws, r);
      wasteful.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, labelColor: C.red }); });
      r += 2;
    }

    // ── 전체 키워드 ──
    r = subTitle(kws, r, `전체 키워드 목록 (${validCount}개, 비용순)`, 15);
    r = kwHeader(kws, r);
    validKw.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1 }); });

    if (unknownKw.length > 0) {
      r += 2;
      r = subTitle(kws, r, `미인식 키워드 (쇼핑검색 등) ${unknownKw.length}개`, 15);
      r = kwHeader(kws, r);
      unknownKw.forEach(([, d], idx) => { r = kwRow(kws, r, d, { stripe: idx % 2 === 1, labelColor: C.gray }); });
    }
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
  // 9. 성별·연령대 (demographics 있을 때만)
  // ══════════════════════════════════════════════════════════════════
  if (demographics && (demographics.gender?.length || demographics.age?.length)) {
    const ds = wb.addWorksheet('성별·연령대');
    setup(ds);
    ds.getColumn(2).width = 16;
    [18, 13, 13, 10, 15, 10, 12, 16].forEach((w, i) => { ds.getColumn(i + 3).width = w; });

    let r = 3;
    r = sectionTitle(ds, r, `성별·연령대별 성과 분석 (${period})`, 10);
    r++;

    const demoHeaders = ['노출수','클릭수','CTR','총비용','비용비중','전환수','전환매출'];
    const demoFmts = [FMT.num, FMT.num, FMT.pct, FMT.won, FMT.pct, FMT.num, FMT.won];

    function demoTableHeader(ws, row, label) {
      const hRow = ws.getRow(row); hRow.height = 26;
      [label, ...demoHeaders].forEach((h, i) => {
        const c = hRow.getCell(i + 2);
        c.value = h; c.font = { bold: true, size: 10, color: { argb: C.dark } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.headerBg } };
        c.alignment = cm; c.border = border;
      });
      return row + 1;
    }

    function demoDataRow(ws, row, label, d, totalCost, opts = {}) {
      const dRow = ws.getRow(row); dRow.height = 23;
      const lc = dRow.getCell(2);
      lc.value = label; lc.font = { size: 10, bold: !!opts.bold, color: { argb: opts.color || C.dark } };
      lc.alignment = cm; lc.border = border;
      if (opts.bg) lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };

      const ctr = d.imp > 0 ? (d.clk / d.imp * 100) : 0;
      const costPct = totalCost > 0 ? (d.cost / totalCost * 100) : 0;
      const vals = [d.imp||0, d.clk||0, ctr, d.cost||0, costPct, d.convCnt||0, d.convAmt||0];
      vals.forEach((v, i) => {
        const c = dRow.getCell(i + 3);
        c.value = v; c.numFmt = demoFmts[i];
        c.font = { size: 10, bold: !!opts.bold, color: { argb: opts.bold ? C.dark : C.gray } };
        c.alignment = cm; c.border = border;
        if (opts.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.bg } };
        else if (opts.stripe) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.altRow } };
      });
      return row + 1;
    }

    // ── 성별 ──
    if (demographics.gender && demographics.gender.length > 0) {
      const genderOrder = ['남성','여성','알수없음'];
      const gData = [...demographics.gender].sort((a,b) => {
        const ai = genderOrder.indexOf(a.label), bi = genderOrder.indexOf(b.label);
        return (ai===-1?99:ai) - (bi===-1?99:bi);
      });
      const gTotal = gData.reduce((s,d) => s+(d.cost||0), 0);

      r = subTitle(ds, r, '👫 성별 성과', 10);
      r = demoTableHeader(ds, r, '성별');
      gData.forEach((d, idx) => {
        const gColors = {'남성':C.blue,'여성':'FFEC4899','알수없음':C.gray};
        r = demoDataRow(ds, r, d.label, d, gTotal, {
          bold: d.label !== '알수없음',
          color: gColors[d.label] || C.dark,
          stripe: idx % 2 === 1,
        });
      });
      // 합계
      const gTotalData = { imp: gData.reduce((s,d) => s+(d.imp||0),0), clk: gData.reduce((s,d) => s+(d.clk||0),0), cost: gTotal, convCnt: gData.reduce((s,d) => s+(d.convCnt||0),0), convAmt: gData.reduce((s,d) => s+(d.convAmt||0),0) };
      r++;
      r = demoDataRow(ds, r, '합계', gTotalData, gTotal, { bold: true, bg: C.totalBg });
      r += 3;
    }

    // ── 연령대 ──
    if (demographics.age && demographics.age.length > 0) {
      const aData = [...demographics.age].sort((a,b) => {
        if (a.label === '알수없음') return 1;
        if (b.label === '알수없음') return -1;
        return (parseInt(b.label)||0) - (parseInt(a.label)||0);
      });
      const aTotal = aData.reduce((s,d) => s+(d.cost||0), 0);

      r = subTitle(ds, r, '📊 연령대별 성과', 10);
      r = demoTableHeader(ds, r, '연령대');
      aData.forEach((d, idx) => {
        r = demoDataRow(ds, r, d.label, d, aTotal, {
          bold: d.label !== '알수없음',
          color: d.label === '알수없음' ? C.gray : C.dark,
          stripe: idx % 2 === 1,
        });
      });
      // 합계
      const aTotalData = { imp: aData.reduce((s,d) => s+(d.imp||0),0), clk: aData.reduce((s,d) => s+(d.clk||0),0), cost: aTotal, convCnt: aData.reduce((s,d) => s+(d.convCnt||0),0), convAmt: aData.reduce((s,d) => s+(d.convAmt||0),0) };
      r++;
      r = demoDataRow(ds, r, '합계', aTotalData, aTotal, { bold: true, bg: C.totalBg });
    }
  }

  return await wb.xlsx.writeBuffer();
}

module.exports = { buildExcelReport };
