const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = 'https://api.naver.com';

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
        timeout: 10000,
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
      throw new Error(`API 오류 [${err.response?.status}] ${path}: ${msg}`);
    }
  }

  return {
    // 연결된 광고주 목록 조회 (매니저 계정용) - 네이버 SA API: GET /managerLinks
    getCustomerLinks: () =>
      apiCall('GET', '/managerLinks'),

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
