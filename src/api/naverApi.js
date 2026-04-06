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

  // 마스터 리포트 다운로드 (인증 헤더 필요)
  async function downloadMasterReport(downloadUrl) {
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

    getStats: ({ timeRange = 'yesterday', startDate, endDate } = {}) => {
      const dateParams = resolveDateParams(timeRange, startDate, endDate);
      return apiCall('GET', '/stats', {
        ...dateParams,
        timeIncrement: 'allDays',
        fields: 'clkCnt,impCnt,salesAmt,crto,ctr,avgRnk',
      });
    },

    getKeywordStats: ({ timeRange = 'yesterday', startDate, endDate } = {}) => {
      const dateParams = resolveDateParams(timeRange, startDate, endDate);
      return apiCall('GET', '/stats', {
        ...dateParams,
        timeIncrement: 'allDays',
        statType: 'KEYWORD',
        fields: 'clkCnt,impCnt,salesAmt,crto,ctr,avgRnk,keywordId',
      });
    },

    updateKeywordBid: (keywordId, bidAmt) =>
      apiCall('PUT', `/ncc/keywords/${keywordId}`, {}, { bidAmt }),

    getBidSimulation: (keywordId) =>
      apiCall('GET', `/ncc/keywords/${keywordId}/bids`),

    // ─── 네이버 마스터 동기화 API ────────────────────────────────
    // 마스터 리포트 생성 요청
    createMasterReport: (item) =>
      apiCall('POST', '/master-reports', {}, { item }),

    // 마스터 리포트 상태 조회
    getMasterReport: (reportId) =>
      apiCall('GET', `/master-reports/${reportId}`),

    // 마스터 리포트 목록 조회
    getMasterReports: () =>
      apiCall('GET', '/master-reports'),

    // 마스터 리포트 다운로드
    downloadMasterReport,

    // 마스터 동기화 전체 프로세스 (생성 → 대기 → 다운로드 → 파싱)
    syncMaster: async (item) => {
      // 1. 마스터 리포트 생성
      const report = await apiCall('POST', '/master-reports', {}, { item });
      const reportId = report.id;

      // 2. 빌드 완료 대기 (최대 30초)
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

      // 3. 다운로드
      const tsvText = await downloadMasterReport(downloadUrl);

      // 4. TSV 파싱
      const lines = tsvText.trim().split('\n').filter(l => l.trim());
      return lines.map(line => line.split('\t'));
    },
  };
}

function resolveDateParams(timeRange, startDate, endDate) {
  if (timeRange === 'yesterday') {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const s = d.toISOString().slice(0, 10);
    return { startDate: s, endDate: s };
  }
  if (timeRange === 'last7days') {
    const end = new Date(); end.setDate(end.getDate() - 1);
    const start = new Date(); start.setDate(start.getDate() - 7);
    return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
  }
  if (timeRange === 'last30days') {
    const end = new Date(); end.setDate(end.getDate() - 1);
    const start = new Date(); start.setDate(start.getDate() - 30);
    return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
  }
  if (startDate && endDate) return { startDate, endDate };
  return {};
}

module.exports = { createApiClient };
