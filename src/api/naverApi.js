const crypto = require('crypto');
const axios = require('axios');
const zlib = require('zlib');

const BASE_URL = 'https://api.searchad.naver.com';

// 동시성 제한 헬퍼 (429 회피 — Promise.allSettled와 동일한 결과 형태 반환)
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    const chunk = items.slice(i, i + limit);
    const res = await Promise.allSettled(chunk.map(fn));
    out.push(...res);
  }
  return out;
}

/**
 * 광고주 계정 자격증명을 받아 API 클라이언트 생성
 * @param {{ apiKey: string, secretKey: string, customerId: string }} creds
 */
function createApiClient(creds) {
  const { apiKey, secretKey, customerId } = creds;

  function makeAuthHeaders(method, path) {
    const timestamp = Date.now().toString();
    const message = `${timestamp}.${method}.${path}`;
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(message)
      .digest('base64');

    return {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Timestamp': timestamp,
      'X-API-KEY': apiKey,
      'X-Customer': customerId,
      'X-Signature': signature,
    };
  }

  async function apiCall(method, path, params = {}, data = null, retryCount = 0) {
    const url = `${BASE_URL}${path}`;
    const headers = makeAuthHeaders(method.toUpperCase(), path);

    try {
      const response = await axios({
        method,
        url,
        headers,
        params: Object.keys(params).length > 0 ? params : undefined,
        data:   method !== 'GET' ? data : undefined,
        timeout: 15000,
      });
      return response.data;
    } catch (err) {
      if (err.response?.status === 429 && retryCount < 3) {
        const wait = Math.pow(2, retryCount) * 1000;
        console.log(`⏳ Rate limit. ${wait / 1000}초 후 재시도...`);
        await new Promise(r => setTimeout(r, wait));
        return apiCall(method, path, params, data, retryCount + 1);
      }
      const respData = err.response?.data;
      const msg = respData?.message || err.message;
      const detail = typeof respData === 'object' ? JSON.stringify(respData) : String(respData || '');
      console.error(`❌ API [${err.response?.status}] ${method} ${path}:`, detail);
      const error = new Error(`API 오류 [${err.response?.status}] ${path}: ${msg} | ${detail}`);
      error.statusCode = err.response?.status;
      error.responseData = respData;
      throw error;
    }
  }

  // 마스터/Stat 리포트 다운로드 (인증 헤더 필요)
  async function downloadReport(downloadUrl) {
    const urlObj = new URL(downloadUrl);
    const path = urlObj.pathname;
    const headers = makeAuthHeaders('GET', path);

    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      headers,
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    // gzip 압축 해제 시도
    let text;
    try {
      text = zlib.gunzipSync(response.data).toString('utf-8');
    } catch (e) {
      text = response.data.toString('utf-8');
    }
    return text;
  }

  // ─── 리포트 job 정리 ───────────────────────────────────────────────
  // master/stat 리포트 job은 계정당 100개 한도. 완료(BUILT/NONE/ERROR) job을
  // 삭제해 누적으로 인한 POST 거부(키워드 미인식·수집 실패)를 방지한다.
  async function cleanupReportJobs({ master = true, stat = true } = {}) {
    let deleted = 0;
    const sweep = async (path) => {
      try {
        const list = await apiCall('GET', path);
        const done = (Array.isArray(list) ? list : []).filter(r => ['BUILT', 'NONE', 'ERROR'].includes(r.status));
        for (let i = 0; i < done.length; i += 10) {
          const chunk = done.slice(i, i + 10);
          await Promise.allSettled(chunk.map(r => apiCall('DELETE', `${path}/${r.id || r.reportJobId}`)));
          deleted += chunk.length;
        }
      } catch (_) {}
    };
    if (master) await sweep('/master-reports');
    if (stat) await sweep('/stat-reports');
    return deleted;
  }

  // ─── Stat Report 공통 함수 ─────────────────────────────────────────
  async function createAndDownloadStatReport(reportTp, statDt) {
    // 1. 리포트 생성 (job 100개 한도 초과 시 완료 job 정리 후 재시도)
    let report;
    try {
      report = await apiCall('POST', '/stat-reports', {}, { reportTp, statDt });
    } catch (e) {
      const blob = `${e.message || ''} ${JSON.stringify(e.responseData || '')}`;
      if (!/exceeded limit|numbers of .?job/i.test(blob)) throw e;
      const n = await cleanupReportJobs({ master: false, stat: true });
      console.log(`  🧹 stat-report job 한도 초과 → 완료 job ${n}개 정리 후 재시도 (${reportTp})`);
      report = await apiCall('POST', '/stat-reports', {}, { reportTp, statDt });
    }
    const reportId = report.reportJobId;
    const delStatJob = () => apiCall('DELETE', `/stat-reports/${reportId}`).catch(() => {});

    // 2. 빌드 완료 대기 (대용량 계정 AD_DETAIL은 15초로 부족 → 30회 × 2초 = 최대 60초)
    let status = report.status;
    let downloadUrl = report.downloadUrl;
    for (let i = 0; i < 30; i++) {
      if (status === 'BUILT' && downloadUrl) break;
      await new Promise(r => setTimeout(r, i < 5 ? 1000 : 2000));
      const check = await apiCall('GET', `/stat-reports/${reportId}`);
      status = check.status;
      downloadUrl = check.downloadUrl;
      if (status === 'ERROR') { await delStatJob(); throw new Error(`Stat Report 빌드 실패 (${reportTp})`); }
    }
    if (status !== 'BUILT') { await delStatJob(); throw new Error(`Stat Report 타임아웃 (${reportTp})`); }

    // 3. 다운로드
    const text = await downloadReport(downloadUrl);

    // 4. 사용 완료 job 즉시 삭제 (계정당 100 한도 — 월간 리포트 186 job이 한도를 넘던 원인)
    //    다운로드 완료 후에는 job이 불필요하므로 fire-and-forget으로 지연 없이 정리
    delStatJob();

    // 5. TSV 파싱
    return text.trim().split('\n').filter(l => l.trim()).map(line => line.split('\t'));
  }

  // ─── 구매완료 전환만 필터링 ────────────────────────────────────────
  async function getPurchaseConversions(dateRange) {
    const result = { totalAmt: 0, totalCnt: 0, byCampaign: {} };

    const dates = getDatesBetween(dateRange.since, dateRange.until);
    for (const dt of dates) {
      try {
        const rows = await createAndDownloadStatReport('AD_CONVERSION_DETAIL', dt);
        // TSV: date, customerId, campaignId, adgroupId, keywordId, adId, channelId,
        //      hour, code, queryId, device, directFlag, convType, convCnt, convAmt
        for (const cols of rows) {
          if (cols.length < 15) continue;
          const convTypeLower = (cols[12] || '').trim().toLowerCase();
          const convTypeRaw = (cols[12] || '').trim();
          // 구매완료 타입만 필터 (영문 + 한국어 + 코드)
          if (convTypeLower === 'purchase' || convTypeLower === 'purchase_complete' || convTypeLower === 'complete_purchase' || convTypeLower === 'conversion' || convTypeLower === 'conv' || convTypeLower === '1' || convTypeRaw === '구매완료') {
            const campaignId = cols[2];
            const cnt = parseInt(cols[13]) || 0;
            const amt = parseInt(cols[14]) || 0;
            result.totalAmt += amt;
            result.totalCnt += cnt;
            if (!result.byCampaign[campaignId]) result.byCampaign[campaignId] = { amt: 0, cnt: 0 };
            result.byCampaign[campaignId].amt += amt;
            result.byCampaign[campaignId].cnt += cnt;
          }
        }
      } catch (e) {
        console.log(`구매완료 전환 조회 실패 (${dt}):`, e.message);
      }
    }
    return result;
  }

  return {
    // 연결된 광고주 목록 조회 (매니저 계정용)
    getCustomerLinks: () =>
      apiCall('GET', '/customer-links'),

    getCampaigns: () =>
      apiCall('GET', '/ncc/campaigns'),

    getAdGroups: (campaignId) =>
      apiCall('GET', '/ncc/adgroups', { nccCampaignId: campaignId }),

    getKeywords: (adGroupId) =>
      apiCall('GET', '/ncc/keywords', { nccAdgroupId: adGroupId }),

    // 캠페인 ID 기반 통계 조회
    getStatById: (id, { timeRange = 'yesterday', startDate, endDate } = {}) => {
      const dateRange = resolveDateRange(timeRange, startDate, endDate);
      return apiCall('GET', '/stats', {
        id,
        fields: JSON.stringify(['clkCnt','impCnt','salesAmt','ctr','avgRnk']),
        timeRange: JSON.stringify(dateRange),
      });
    },

    // ─── 지역별/요일별 breakdown 통계 조회 ────────────────────────────
    // breakdown: 'regnNo'(지역), 'dayw'(요일), 'hh24'(시간), 'pcMblTp'(PC/모바일)
    getStatsByBreakdown: async (breakdown, { timeRange = 'last7days', startDate, endDate } = {}) => {
      const campaigns = await apiCall('GET', '/ncc/campaigns');
      const dateRange = resolveDateRange(timeRange, startDate, endDate);
      const byBreakdown = {};

      const statsResults = await mapLimit(campaigns || [], 8, camp =>
        apiCall('GET', '/stats', {
          id: camp.nccCampaignId,
          fields: JSON.stringify(['clkCnt', 'impCnt', 'salesAmt', 'cpc', 'ccnt']),
          timeRange: JSON.stringify(dateRange),
          timeIncrement: 'allDays',
          breakdown,
        }).then(result => ({ camp, result }))
      );

      for (const sr of statsResults) {
        if (sr.status !== 'fulfilled') continue;
        const { result } = sr.value;
        if (!result?.data?.length) continue;
        for (const d of result.data) {
          if (!d.breakdowns?.length) continue;
          for (const bd of d.breakdowns) {
            const key = bd.name || 'unknown';
            if (!byBreakdown[key]) byBreakdown[key] = { impCnt: 0, clkCnt: 0, salesAmt: 0, ccnt: 0 };
            byBreakdown[key].impCnt += bd.impCnt || 0;
            byBreakdown[key].clkCnt += bd.clkCnt || 0;
            byBreakdown[key].salesAmt += bd.salesAmt || 0;
            byBreakdown[key].ccnt += bd.ccnt || 0;
          }
        }
      }

      // 계산 필드 추가
      Object.values(byBreakdown).forEach(v => {
        v.ctr = v.impCnt > 0 ? (v.clkCnt / v.impCnt * 100) : 0;
        v.cpc = v.clkCnt > 0 ? Math.round(v.salesAmt / v.clkCnt) : 0;
      });

      return byBreakdown;
    },

    // ─── 전체 캠페인 통계 합산 조회 ─────────────────────────────────
    // salesAmt=총비용, convAmt=총전환매출(장바구니포함), purchaseAmt=구매완료전환매출
    getStats: async ({ timeRange = 'yesterday', startDate, endDate } = {}) => {
      const campaigns = await apiCall('GET', '/ncc/campaigns');
      const dateRange = resolveDateRange(timeRange, startDate, endDate);
      const totals = {
        impCnt: 0, clkCnt: 0, salesAmt: 0, convAmt: 0,
        ccnt: 0, ctr: 0, avgRnk: 0, cpc: 0,
        purchaseCcnt: 0, purchaseConvAmt: 0,
      };
      let campCount = 0;
      const campStats = [];

      // 모든 캠페인 Stats API 호출 (purchaseCcnt, purchaseConvAmt 포함) — 동시 8개 제한
      const statsResults = await mapLimit(campaigns || [], 8, camp =>
        apiCall('GET', '/stats', {
          id: camp.nccCampaignId,
          fields: JSON.stringify(['clkCnt','impCnt','salesAmt','ctr','avgRnk','convAmt','ccnt','cpc','crto','purchaseCcnt','purchaseConvAmt']),
          timeRange: JSON.stringify(dateRange),
        }).then(result => ({ camp, result }))
      );

      for (const sr of statsResults) {
        if (sr.status !== 'fulfilled') continue;
        const { camp, result } = sr.value;
        if (result?.data?.length > 0) {
          const campTotal = { impCnt: 0, clkCnt: 0, salesAmt: 0, convAmt: 0, ccnt: 0, avgRnk: 0, cpc: 0, purchaseCcnt: 0, purchaseConvAmt: 0 };
          let campRankCount = 0;
          for (const d of result.data) {
            campTotal.impCnt += d.impCnt || 0;
            campTotal.clkCnt += d.clkCnt || 0;
            campTotal.salesAmt += d.salesAmt || 0;
            campTotal.convAmt += d.convAmt || 0;
            campTotal.ccnt += d.ccnt || 0;
            campTotal.purchaseCcnt += d.purchaseCcnt || 0;
            campTotal.purchaseConvAmt += d.purchaseConvAmt || 0;
            if (d.avgRnk > 0) { campTotal.avgRnk += d.avgRnk; campRankCount++; }
          }
          if (campRankCount > 0) campTotal.avgRnk = campTotal.avgRnk / campRankCount;
          campTotal.cpc = campTotal.clkCnt > 0 ? Math.round(campTotal.salesAmt / campTotal.clkCnt) : 0;

          totals.impCnt += campTotal.impCnt;
          totals.clkCnt += campTotal.clkCnt;
          totals.salesAmt += campTotal.salesAmt;
          totals.convAmt += campTotal.convAmt;
          totals.ccnt += campTotal.ccnt;
          totals.purchaseCcnt += campTotal.purchaseCcnt;
          totals.purchaseConvAmt += campTotal.purchaseConvAmt;
          totals.avgRnk += campTotal.avgRnk;
          campCount++;
          campStats.push({ name: camp.name, id: camp.nccCampaignId, ...campTotal });
        }
      }

      if (campCount > 0) totals.avgRnk = totals.avgRnk / campCount;
      totals.ctr = totals.impCnt > 0 ? (totals.clkCnt / totals.impCnt * 100) : 0;
      totals.cpc = totals.clkCnt > 0 ? Math.round(totals.salesAmt / totals.clkCnt) : 0;

      totals.campStats = campStats;
      return totals;
    },

    // ─── 대시보드 정합 차원 데이터 (/stats 기반: 일자별·광고그룹별 정확 집계) ───
    // 핵심: 상세 리포트(AD_DETAIL/전환 리포트)는 과거기간(>약 2개월)·31일초과 breakdown이
    // 막혀 일자별/광고그룹별 비용·전환이 누락된다. 네이버 대시보드와 동일한 /stats(캠페인·
    // 광고그룹 단위, 일일 행)로 재구성해 다차원보고서와 오차 0을 보장한다.
    // dateOnly=true면 일자별(byDate)만 수집 (트렌드 차트 등 — 광고그룹 API 콜 절약)
    getDashboardDimensions: async ({ startDate, endDate, dateOnly } = {}) => {
      const dateRange = { since: startDate, until: endDate };
      const trStr = JSON.stringify(dateRange);
      const FIELDS = JSON.stringify(['clkCnt','impCnt','salesAmt','avgRnk','ccnt','convAmt','purchaseCcnt','purchaseConvAmt']);
      const campaigns = await apiCall('GET', '/ncc/campaigns');

      const addRow = (o, d) => {
        o.imp += d.impCnt || 0;
        o.clk += d.clkCnt || 0;
        o.cost += d.salesAmt || 0;
        o.purchaseCnt += d.purchaseCcnt || 0;
        o.purchaseAmt += d.purchaseConvAmt || 0;
        o.convCnt += d.ccnt || 0;
        o.convAmt += d.convAmt || 0;
        if (d.avgRnk > 0) { const w = d.impCnt || 1; o.rankSum += d.avgRnk * w; o.rankCount += w; }
      };
      const blank = (extra) => Object.assign({ imp:0, clk:0, cost:0, rankSum:0, rankCount:0, purchaseCnt:0, purchaseAmt:0, convCnt:0, convAmt:0 }, extra || {});

      // 1) 일자별 + 캠페인별 + 전체: 캠페인별 일일 행(default timeIncrement) 1회 조회로 모두 산출
      //    (기존에는 총합용 getStats가 같은 /stats를 캠페인마다 한 번 더 호출 — 중복 제거)
      const byDate = {};
      const byCampaign = {};
      const total = blank();
      const dailyRes = await mapLimit(campaigns || [], 8, (camp) =>
        apiCall('GET', '/stats', { id: camp.nccCampaignId, fields: FIELDS, timeRange: trStr })
          .then(result => ({ camp, result }))
      );
      for (const sr of dailyRes) {
        if (sr.status !== 'fulfilled') continue;
        const { camp, result } = sr.value;
        for (const d of (result?.data || [])) {
          const date = d.dateStart || d.date;
          if (!date) continue;
          if (!byDate[date]) byDate[date] = blank();
          addRow(byDate[date], d);
          if (!byCampaign[camp.nccCampaignId]) byCampaign[camp.nccCampaignId] = blank({ name: camp.name });
          addRow(byCampaign[camp.nccCampaignId], d);
          addRow(total, d);
        }
      }
      if (dateOnly) return { byDate, byAdgroup: {}, byCampaign, total };

      // 2) 광고그룹별: 광고그룹 단위 /stats(allDays)
      const agListRes = await mapLimit(campaigns || [], 8, (camp) =>
        apiCall('GET', '/ncc/adgroups', { nccCampaignId: camp.nccCampaignId }).then(ags => ({ camp, ags }))
      );
      const allAgs = [];
      for (const r of agListRes) {
        if (r.status !== 'fulfilled') continue;
        for (const ag of (r.value.ags || [])) allAgs.push({ ag, camp: r.value.camp });
      }
      const byAdgroup = {};
      const agStatRes = await mapLimit(allAgs, 8, ({ ag, camp }) =>
        apiCall('GET', '/stats', { id: ag.nccAdgroupId, fields: FIELDS, timeRange: trStr, timeIncrement: 'allDays' })
          .then(stat => ({ ag, camp, stat }))
      );
      for (const r of agStatRes) {
        if (r.status !== 'fulfilled') continue;
        const { ag, camp, stat } = r.value;
        const rows = stat?.data || [];
        if (!rows.length) continue;
        const o = blank({ campaignId: camp.nccCampaignId, campaignName: camp.name, adgroupName: ag.name });
        for (const d of rows) addRow(o, d);
        byAdgroup[ag.nccAdgroupId] = o;
      }

      return { byDate, byAdgroup, byCampaign, total };
    },

    // ─── 광고그룹별 통계 조회 ───────────────────────────────────────
    getKeywordStats: async ({ timeRange = 'yesterday', startDate, endDate } = {}) => {
      const campaigns = await apiCall('GET', '/ncc/campaigns');
      const dateRange = resolveDateRange(timeRange, startDate, endDate);
      const results = [];

      // 모든 캠페인의 광고그룹 조회 — 동시 8개 제한
      const agResults = await mapLimit(campaigns || [], 8, camp =>
        apiCall('GET', '/ncc/adgroups', { nccCampaignId: camp.nccCampaignId })
          .then(ags => ({ camp, ags }))
      );

      const allAgs = [];
      for (const r of agResults) {
        if (r.status !== 'fulfilled') continue;
        for (const ag of (r.value.ags || [])) {
          allAgs.push({ ag, camp: r.value.camp });
        }
      }

      // 모든 광고그룹 Stats 조회 — 동시 8개 제한
      const statResults = await mapLimit(allAgs, 8, ({ ag, camp }) =>
        apiCall('GET', '/stats', {
          id: ag.nccAdgroupId,
          fields: JSON.stringify(['clkCnt','impCnt','salesAmt','ctr','avgRnk','convAmt','ccnt','cpc']),
          timeRange: JSON.stringify(dateRange),
        }).then(stat => ({ ag, camp, stat }))
      );

      for (const r of statResults) {
        if (r.status !== 'fulfilled') continue;
        const { ag, camp, stat } = r.value;
        const d = { impCnt: 0, clkCnt: 0, salesAmt: 0, convAmt: 0, ccnt: 0, avgRnk: 0, cpc: 0 };
        let rkCnt = 0;
        for (const row of (stat?.data || [])) {
          d.impCnt += row.impCnt || 0;
          d.clkCnt += row.clkCnt || 0;
          d.salesAmt += row.salesAmt || 0;
          d.convAmt += row.convAmt || 0;
          d.ccnt += row.ccnt || 0;
          if (row.avgRnk > 0) { d.avgRnk += row.avgRnk; rkCnt++; }
        }
        if (rkCnt > 0) d.avgRnk = d.avgRnk / rkCnt;
        d.ctr = d.impCnt > 0 ? (d.clkCnt / d.impCnt * 100) : 0;
        d.cpc = d.clkCnt > 0 ? Math.round(d.salesAmt / d.clkCnt) : 0;
        if (d.impCnt > 0 || d.clkCnt > 0) {
          results.push({ keyword: ag.name, campaignName: camp.name, adgroupId: ag.nccAdgroupId, ...d });
        }
      }

      return results;
    },

    getKeywordInfo: (keywordId) =>
      apiCall('GET', `/ncc/keywords/${keywordId}`),

    updateKeywordBid: async (keywordId, bidAmt) => {
      // 키워드 정보 조회 → nccAdgroupId 획득 (필수)
      const kwInfo = await apiCall('GET', `/ncc/keywords/${keywordId}`);
      const adgroupId = kwInfo?.nccAdgroupId;
      if (!adgroupId) throw new Error('nccAdgroupId를 찾을 수 없습니다');

      return await apiCall('PUT', `/ncc/keywords/${keywordId}`, { fields: 'bidAmt' }, {
        nccKeywordId: keywordId,
        nccAdgroupId: adgroupId,
        bidAmt,
        useGroupBidAmt: false,
      });
    },

    // 목표 순위에 필요한 입찰가 추정
    getEstimatedBidForPosition: (keywordId, device, position) =>
      apiCall('POST', '/estimate/average-position-bid/id', {}, {
        device: device === 'MO' ? 'MOBILE' : 'PC',
        items: [{ key: keywordId, position }]
      }),

    // 여러 순위의 입찰가를 한번에 조회 (현재 순위 추정용)
    getEstimatedBidsForPositions: (keywordId, device, positions) =>
      apiCall('POST', '/estimate/average-position-bid/id', {}, {
        device: device === 'MO' ? 'MOBILE' : 'PC',
        items: positions.map(p => ({ key: keywordId, position: p }))
      }),

    // 노출 최소 입찰가
    getExposureMinBid: (keywordId, device) =>
      apiCall('POST', '/estimate/exposure-minimum-bid/id', {}, {
        device: device === 'MO' ? 'MOBILE' : 'PC',
        items: [{ key: keywordId }]
      }),

    // 중간 입찰가
    getMedianBid: (keywordId, device) =>
      apiCall('POST', '/estimate/median-bid/id', {}, {
        device: device === 'MO' ? 'MOBILE' : 'PC',
        items: [{ key: keywordId }]
      }),

    // 입찰가별 성과 예측
    getPerformanceEstimate: (keywordId, device, bids) =>
      apiCall('POST', '/estimate/performance/id', {}, {
        device: device === 'MO' ? 'MOBILE' : 'PC',
        keywordplus: false,
        key: keywordId,
        bids,
      }),

    // ─── 광고 소재 / 비즈채널 조회 ─────────────────────────────────────
    getAds: (adGroupId) =>
      apiCall('GET', '/ncc/ads', { nccAdgroupId: adGroupId }),

    getAdDetail: (adId) =>
      apiCall('GET', `/ncc/ads/${adId}`),

    // 쇼핑검색 소재 입찰가 수정 (adAttr.bidAmt)
    updateAdBid: async (adId, bidAmt) => {
      const adDetail = await apiCall('GET', `/ncc/ads/${adId}`);
      if (!adDetail) throw new Error('소재 정보 조회 실패');
      const adAttr = adDetail.adAttr || {};
      adAttr.bidAmt = bidAmt;
      return await apiCall('PUT', `/ncc/ads/${adId}`, { fields: 'adAttr' }, {
        nccAdId: adId,
        nccAdgroupId: adDetail.nccAdgroupId,
        adAttr,
      });
    },

    getAdGroupDetail: (adGroupId) =>
      apiCall('GET', `/ncc/adgroups/${adGroupId}`),

    getChannels: () =>
      apiCall('GET', '/ncc/channels'),

    // ─── 광고 노출 진단 (실시간 순위) ──────────────────────────────────
    getImpressionPreviewPowerLink: (keyword, device, regionalCode = '09140103') => {
      const channelAlias = device === 'MO'
        ? 'naver.search.mo.plsearch'
        : 'naver.search.pc.plsearch';
      return apiCall('GET', '/ncc/impression-preview/power-link', {
        keyword,
        channelAlias,
        regionalCode,
      });
    },

    getImpressionStatus: (keyword, nccKeywordId) =>
      apiCall('GET', '/ncc/impression-preview/impression-status', {
        keyword,
        nccKeywordId,
      }),

    // ─── 네이버 마스터 동기화 API ────────────────────────────────────
    createMasterReport: (item) =>
      apiCall('POST', '/master-reports', {}, { item }),

    getMasterReport: (reportId) =>
      apiCall('GET', `/master-reports/${reportId}`),

    getMasterReports: () =>
      apiCall('GET', '/master-reports'),

    downloadMasterReport: downloadReport,

    // 마스터 동기화 전체 프로세스 (Full 또는 Delta)
    // fromTime: ISO 8601 형식 → 해당 시점 이후 변경분만 다운로드 (Delta sync)
    syncMaster: async (item, fromTime) => {
      // ⚠️ 마스터 리포트 job은 계정당 100개 한도. 누적되면 POST가
      // "exceeded limit of '100' numbers of 'job'"로 거부되어 키워드/이름이
      // 미해결(ID 미인식)된다. → 사용 후 job 삭제 + 한도 초과 시 자동 정리.
      const delJob = async (id) => { try { await apiCall('DELETE', `/master-reports/${id}`); } catch (_) {} };
      const cleanupCompleted = async () => {
        try {
          const ex = await apiCall('GET', '/master-reports');
          const completed = (Array.isArray(ex) ? ex : []).filter(r => ['BUILT', 'NONE', 'ERROR'].includes(r.status));
          for (const r of completed) await delJob(r.id);
          return completed.length;
        } catch (_) { return 0; }
      };

      const body = { item };
      if (fromTime) body.fromTime = fromTime;
      let report;
      try {
        report = await apiCall('POST', '/master-reports', {}, body);
      } catch (e) {
        const blob = `${e.message || ''} ${JSON.stringify(e.responseData || '')}`;
        if (!/exceeded limit|numbers of .?job/i.test(blob)) throw e;
        const n = await cleanupCompleted();
        console.log(`  🧹 마스터리포트 job 100개 한도 초과 → 완료 job ${n}개 정리 후 재시도 (${item})`);
        report = await apiCall('POST', '/master-reports', {}, body);
      }
      const reportId = report.id;

      let status = report.status;
      let downloadUrl = report.downloadUrl;
      // 대용량 계정(5만+ 키워드 등) 대응: Keyword는 90회 × 2초 = 최대 3분 폴링
      const maxPolls = (item === 'Keyword') ? 90 : 30;
      for (let i = 0; i < maxPolls && status !== 'BUILT'; i++) {
        if (status === 'NONE') { await delJob(reportId); return []; } // 변경 데이터 없음 (Delta sync)
        await new Promise(r => setTimeout(r, 2000));
        const check = await apiCall('GET', `/master-reports/${reportId}`);
        status = check.status;
        downloadUrl = check.downloadUrl;
        if (status === 'ERROR') { await delJob(reportId); throw new Error(`마스터 리포트 빌드 실패 (${item})`); }
      }
      if (status === 'NONE') { await delJob(reportId); return []; } // 변경분 없음
      if (status !== 'BUILT') { await delJob(reportId); throw new Error(`마스터 리포트 타임아웃 (${item})`); }

      const tsvText = await downloadReport(downloadUrl);
      const lines = tsvText.trim().split('\n').filter(l => l.trim());
      const result = lines.map(line => line.split('\t'));
      await delJob(reportId); // 사용 완료 job 삭제 (누적 방지 — 핵심)
      return result;
    },

    // ─── 키워드도구 (연관 키워드 + 월간 검색량) ──────────────────────
    // hintKeywords: 최대 5개. 반환: keywordList[{relKeyword, monthlyPcQcCnt, monthlyMobileQcCnt, compIdx, ...}]
    getRelatedKeywords: async (hintKeywords) => {
      const hints = (hintKeywords || []).filter(Boolean).slice(0, 5);
      if (hints.length === 0) return [];
      // 검색어에 공백 포함 시 키워드도구가 거부 → 공백 제거 (네이버 규칙)
      const cleaned = hints.map(k => String(k).replace(/\s+/g, ''));
      try {
        const r = await apiCall('GET', '/keywordstool', {
          hintKeywords: cleaned.join(','),
          showDetail: 1,
        });
        return r?.keywordList || [];
      } catch (e) {
        console.log('  ⚠️ 키워드도구 조회 실패:', e.message);
        return [];
      }
    },

    // ─── 임의 엔터티(캠페인/광고그룹/소재) /stats 일별 행 조회 ────────
    // 입찰관리 앱: 소재(nccAdId) 단위 일별 성과 (간접전환 포함 convAmt/ccnt)
    getEntityStats: (id, { since, until, fields } = {}) =>
      apiCall('GET', '/stats', {
        id,
        fields: JSON.stringify(fields || ['clkCnt','impCnt','salesAmt','cpc','avgRnk','ccnt','convAmt']),
        timeRange: JSON.stringify({ since, until }),
      }),

    // ─── Stat Report 직접 접근 ──────────────────────────────────────
    createAndDownloadStatReport,
    getPurchaseConversions,
    cleanupReportJobs,
  };
}

// ─── 날짜 유틸리티 ──────────────────────────────────────────────────
// KST(UTC+9) 기준 날짜 포맷
function fmtKST(d) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function resolveDateRange(timeRange, startDate, endDate) {
  // 명시적 날짜 범위가 있으면 우선 사용
  if (startDate && endDate) return { since: startDate, until: endDate };
  const now = new Date();
  if (timeRange === 'yesterday') {
    const d = new Date(now); d.setDate(d.getDate() - 1);
    const s = fmtKST(d);
    return { since: s, until: s };
  }
  if (timeRange === 'last7days') {
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return { since: fmtKST(start), until: fmtKST(end) };
  }
  if (timeRange === 'last30days') {
    const end = new Date(now); end.setDate(end.getDate() - 1);
    const start = new Date(now); start.setDate(start.getDate() - 30);
    return { since: fmtKST(start), until: fmtKST(end) };
  }
  if (startDate && endDate) return { since: startDate, until: endDate };
  const d = new Date(now); d.setDate(d.getDate() - 1);
  return { since: fmtKST(d), until: fmtKST(d) };
}

// since~until 사이의 날짜 배열 반환 (YYYY-MM-DD)
function getDatesBetween(since, until) {
  const dates = [];
  const start = new Date(since);
  const end = new Date(until);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

module.exports = { createApiClient };
