const crypto = require('crypto');
const axios = require('axios');
const zlib = require('zlib');

const BASE_URL = 'https://api.searchad.naver.com';

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
        params: method === 'GET' ? params : undefined,
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
      const msg = err.response?.data?.message || err.message;
      const error = new Error(`API 오류 [${err.response?.status}] ${path}: ${msg}`);
      error.statusCode = err.response?.status;
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

  // ─── Stat Report 공통 함수 ─────────────────────────────────────────
  async function createAndDownloadStatReport(reportTp, statDt) {
    // 1. 리포트 생성
    const report = await apiCall('POST', '/stat-reports', {}, { reportTp, statDt });
    const reportId = report.reportJobId;

    // 2. 빌드 완료 대기 (최대 30초)
    let status = report.status;
    let downloadUrl = report.downloadUrl;
    for (let i = 0; i < 15; i++) {
      if (status === 'BUILT' && downloadUrl) break;
      await new Promise(r => setTimeout(r, 1000));
      const check = await apiCall('GET', `/stat-reports/${reportId}`);
      status = check.status;
      downloadUrl = check.downloadUrl;
      if (status === 'ERROR') throw new Error(`Stat Report 빌드 실패 (${reportTp})`);
    }
    if (status !== 'BUILT') throw new Error(`Stat Report 타임아웃 (${reportTp})`);

    // 3. 다운로드
    const text = await downloadReport(downloadUrl);

    // 4. TSV 파싱
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
          const convType = cols[12];
          // 구매완료 타입만 필터 (purchase, purchase_complete 등)
          if (convType === 'purchase' || convType === 'purchase_complete' || convType === 'complete_purchase') {
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

    // ─── 전체 캠페인 통계 합산 조회 ─────────────────────────────────
    // salesAmt=총비용, convAmt=총전환매출(장바구니포함), purchaseAmt=구매완료전환매출
    getStats: async ({ timeRange = 'yesterday', startDate, endDate } = {}) => {
      const campaigns = await apiCall('GET', '/ncc/campaigns');
      const dateRange = resolveDateRange(timeRange, startDate, endDate);
      const totals = {
        impCnt: 0, clkCnt: 0, salesAmt: 0, convAmt: 0,
        ccnt: 0, ctr: 0, avgRnk: 0, cpc: 0,
        purchaseAmt: 0, purchaseCnt: 0,
      };
      let campCount = 0;
      const campStats = [];

      // 모든 캠페인 Stats API 병렬 호출 (속도 향상)
      const statsResults = await Promise.allSettled(
        (campaigns || []).map(camp =>
          apiCall('GET', '/stats', {
            id: camp.nccCampaignId,
            fields: JSON.stringify(['clkCnt','impCnt','salesAmt','ctr','avgRnk','convAmt','ccnt','cpc','crto']),
            timeRange: JSON.stringify(dateRange),
          }).then(result => ({ camp, result }))
        )
      );

      for (const sr of statsResults) {
        if (sr.status !== 'fulfilled') continue;
        const { camp, result } = sr.value;
        if (result?.data?.length > 0) {
          const campTotal = { impCnt: 0, clkCnt: 0, salesAmt: 0, convAmt: 0, ccnt: 0, avgRnk: 0, cpc: 0 };
          let campRankCount = 0;
          for (const d of result.data) {
            campTotal.impCnt += d.impCnt || 0;
            campTotal.clkCnt += d.clkCnt || 0;
            campTotal.salesAmt += d.salesAmt || 0;
            campTotal.convAmt += d.convAmt || 0;
            campTotal.ccnt += d.ccnt || 0;
            if (d.avgRnk > 0) { campTotal.avgRnk += d.avgRnk; campRankCount++; }
          }
          if (campRankCount > 0) campTotal.avgRnk = campTotal.avgRnk / campRankCount;
          campTotal.cpc = campTotal.clkCnt > 0 ? Math.round(campTotal.salesAmt / campTotal.clkCnt) : 0;

          totals.impCnt += campTotal.impCnt;
          totals.clkCnt += campTotal.clkCnt;
          totals.salesAmt += campTotal.salesAmt;
          totals.convAmt += campTotal.convAmt;
          totals.ccnt += campTotal.ccnt;
          totals.avgRnk += campTotal.avgRnk;
          campCount++;
          campStats.push({ name: camp.name, id: camp.nccCampaignId, ...campTotal });
        }
      }

      if (campCount > 0) totals.avgRnk = totals.avgRnk / campCount;
      totals.ctr = totals.impCnt > 0 ? (totals.clkCnt / totals.impCnt * 100) : 0;
      totals.cpc = totals.clkCnt > 0 ? Math.round(totals.salesAmt / totals.clkCnt) : 0;

      // 구매완료 전환 데이터는 dashboard에서 별도 캐시+병렬로 처리
      totals.campStats = campStats;
      return totals;
    },

    // ─── 광고그룹별 통계 조회 ───────────────────────────────────────
    getKeywordStats: async ({ timeRange = 'yesterday', startDate, endDate } = {}) => {
      const campaigns = await apiCall('GET', '/ncc/campaigns');
      const dateRange = resolveDateRange(timeRange, startDate, endDate);
      const results = [];

      // 모든 캠페인의 광고그룹을 병렬 조회
      const agResults = await Promise.allSettled(
        (campaigns || []).map(camp =>
          apiCall('GET', '/ncc/adgroups', { nccCampaignId: camp.nccCampaignId })
            .then(ags => ({ camp, ags }))
        )
      );

      const allAgs = [];
      for (const r of agResults) {
        if (r.status !== 'fulfilled') continue;
        for (const ag of (r.value.ags || [])) {
          allAgs.push({ ag, camp: r.value.camp });
        }
      }

      // 모든 광고그룹 Stats를 병렬 조회
      const statResults = await Promise.allSettled(
        allAgs.map(({ ag, camp }) =>
          apiCall('GET', '/stats', {
            id: ag.nccAdgroupId,
            fields: JSON.stringify(['clkCnt','impCnt','salesAmt','ctr','avgRnk','convAmt','ccnt','cpc']),
            timeRange: JSON.stringify(dateRange),
          }).then(stat => ({ ag, camp, stat }))
        )
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

    updateKeywordBid: (keywordId, bidAmt) =>
      apiCall('PUT', `/ncc/keywords/${keywordId}`, {}, { bidAmt }),

    getBidSimulation: (keywordId) =>
      apiCall('GET', `/ncc/keywords/${keywordId}/bids`),

    // ─── 네이버 마스터 동기화 API ────────────────────────────────────
    createMasterReport: (item) =>
      apiCall('POST', '/master-reports', {}, { item }),

    getMasterReport: (reportId) =>
      apiCall('GET', `/master-reports/${reportId}`),

    getMasterReports: () =>
      apiCall('GET', '/master-reports'),

    downloadMasterReport: downloadReport,

    // 마스터 동기화 전체 프로세스
    syncMaster: async (item) => {
      const report = await apiCall('POST', '/master-reports', {}, { item });
      const reportId = report.id;

      let status = report.status;
      let downloadUrl = report.downloadUrl;
      for (let i = 0; i < 15 && status !== 'BUILT'; i++) {
        await new Promise(r => setTimeout(r, 2000));
        const check = await apiCall('GET', `/master-reports/${reportId}`);
        status = check.status;
        downloadUrl = check.downloadUrl;
        if (status === 'ERROR') throw new Error(`마스터 리포트 빌드 실패 (${item})`);
      }
      if (status !== 'BUILT') throw new Error(`마스터 리포트 타임아웃 (${item})`);

      const tsvText = await downloadReport(downloadUrl);
      const lines = tsvText.trim().split('\n').filter(l => l.trim());
      return lines.map(line => line.split('\t'));
    },

    // ─── Stat Report 직접 접근 ──────────────────────────────────────
    createAndDownloadStatReport,
    getPurchaseConversions,
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
