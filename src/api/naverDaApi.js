/**
 * 네이버 디스플레이광고(DA / GFA) API 클라이언트
 *
 * 인증: ads.naver.com 세션 쿠키 + X-Xsrf-Token 헤더
 * 베이스 URL: https://ads.naver.com/apis/stats/v1/adAccounts/{adAccountNo}/stats/...
 *
 * 사용자가 F12에서 캡처한 쿠키 + XSRF 토큰을 ad_accounts에 저장해두고 활용
 */
const https = require('https');
const { URL } = require('url');

const BASE_HOST = 'ads.naver.com';
const BASE_PATH = '/apis/stats/v1/adAccounts';

/**
 * 단일 페이지 호출 (저수준)
 */
function fetchOnce(adAccountNo, params, cookie, xsrfToken, refererPath) {
  return new Promise((resolve, reject) => {
    const search = new URLSearchParams(params).toString();
    const path = `${BASE_PATH}/${adAccountNo}/stats/reportPerformance?${search}`;
    const referer = refererPath || `https://${BASE_HOST}/manage/ad-accounts/${adAccountNo}/da/report/performance`;

    const opts = {
      hostname: BASE_HOST,
      port: 443,
      path,
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
        cookie: cookie,
        'x-xsrf-token': xsrfToken,
        referer,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
      },
      timeout: 30000,
    };

    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 401 || res.statusCode === 403) {
          return reject(new Error(`DA 인증 실패 (${res.statusCode}): 쿠키 또는 XSRF 토큰이 만료되었거나 잘못되었습니다. 광고주 설정에서 다시 갱신해주세요.`));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`DA API 오류 ${res.statusCode}: ${body.slice(0, 300)}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`DA 응답 파싱 실패: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('DA 요청 타임아웃')); });
    req.end();
  });
}

/**
 * reportPerformance 호출 + 페이지네이션 자동 처리
 *
 * @param {object} args
 *   adAccountNo: number/string
 *   cookie: string (전체 Cookie 헤더)
 *   xsrfToken: string
 *   startDate, endDate: 'YYYY-MM-DD'
 *   reportAdUnit: 'AD_ACCOUNT'|'CAMPAIGN'|'AD_SET'|'ASSET_GROUP'|'CREATIVE'|'AD_GROUP'
 *   audience: 'TOTAL'|'AGE'|'GENDER'|'AGE_AND_GENDER'|'DEVICE'|'DEVICE_AND_OS'
 *   placeUnit: 'TOTAL'|'MEDIA_GROUP'|'MEDIA_GROUP_AND_PLACE'
 *   dateUnit: 'TOTAL'|'DAY'|'WEEK'|'MONTH'|'HOUR'
 *   pageSize: number (기본 100)
 *   maxPages: number (안전장치, 기본 50)
 */
async function fetchReportPerformance(args) {
  const {
    adAccountNo, cookie, xsrfToken,
    startDate, endDate,
    reportAdUnit = 'CAMPAIGN',
    audience = 'TOTAL',
    placeUnit = 'TOTAL',
    dateUnit = 'TOTAL',
    pageSize = 100,
    maxPages = 50,
    refererPath,
  } = args;

  if (!cookie) throw new Error('DA 쿠키가 등록되지 않았습니다. 광고주 설정에서 ads.naver.com 쿠키를 입력해주세요.');
  if (!xsrfToken) throw new Error('DA XSRF 토큰이 등록되지 않았습니다.');
  if (!adAccountNo) throw new Error('DA 광고계정 번호 누락');

  const allRows = [];
  let pageNumber = 1;
  let totalPage = 1;
  do {
    const params = {
      startDate, endDate,
      reportAdUnit,
      audience,
      placeUnit,
      dateUnit,
      reportFilterListString: '[]',
      pageNumber: String(pageNumber),
      pageSize: String(pageSize),
    };
    const json = await fetchOnce(adAccountNo, params, cookie, xsrfToken, refererPath);
    const list = json.reportPerformanceDetailResponseList || [];
    allRows.push(...list);
    totalPage = json.totalPage || 1;
    pageNumber++;
    if (pageNumber > maxPages) break;
  } while (pageNumber <= totalPage);

  return allRows;
}

/**
 * 행 → 통일된 메트릭 객체 (대시보드/리포트에서 일관되게 사용)
 */
function normalizeRow(r) {
  return {
    // 식별자
    campaignNo: r.campaignNo,
    campaignName: r.campaignName,
    campaignObjective: r.campaignObjective, // PMAX / CATALOG / CONVERSION 등
    campaignDeleted: !!r.campaignDeleted,
    campaignBudgetAmount: r.campaignBudgetAmount,
    adSetNo: r.adSetNo,
    adSetName: r.adSetName,
    assetGroupNo: r.assetGroupNo,
    assetGroupName: r.assetGroupName,
    creativeNo: r.creativeNo,
    creativeName: r.creativeName,
    // 브레이크다운
    gender: r.gender, // M, F, U(미상)
    ageGroup: r.ageGroup, // AGE_10/20/30/...
    deviceType: r.deviceType,
    platform: r.platform,
    publisherGroupCode: r.publisherGroupCode,
    placementGroupCode: r.placementGroupCode,
    // 메트릭
    imp: Number(r.impCount || 0),
    clk: Number(r.clickCount || 0),
    cost: Number(r.sales || 0),
    cpc: Number(r.cpc || 0),
    cpm: Number(r.cpm || 0),
    ctr: Number(r.ctr || 0),
    convCount: Number(r.convCount || 0),
    purchaseConvCount: Number(r.purchaseConvCount || 0),
    cartConvCount: Number(r.cartConvCount || 0),
    convSales: Number(r.convSales || 0),
    purchaseConvSales: Number(r.purchaseConvSales || 0),
    cartConvSales: Number(r.cartConvSales || 0),
    cvr: Number(r.cvr || 0),
    roas: Number(r.roas || 0),
    purchaseRoas: Number(r.purchaseRoas || 0),
    resultCount: Number(r.resultCount || 0),
    resultString: r.resultString || '',
    salesPerResult: Number(r.salesPerResult || 0),
    salesPerResultString: r.salesPerResultString || '',
    // 비디오 메트릭 (있으면)
    vplayCount: Number(r.vplayCount || 0),
    vtr: Number(r.vtr || 0),
    cpv: Number(r.cpv || 0),
    // 일정
    scheduleString: r.scheduleString || '',
  };
}

module.exports = {
  fetchReportPerformance,
  normalizeRow,
};
