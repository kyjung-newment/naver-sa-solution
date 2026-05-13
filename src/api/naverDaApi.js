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
 * endpoint: 'reportPerformance' (페이지네이션) | 'reportPerformanceDetail' (브레이크다운, 단일 응답)
 */
function fetchOnce(adAccountNo, params, cookie, xsrfToken, refererPath, endpoint) {
  return new Promise((resolve, reject) => {
    const search = new URLSearchParams(params).toString();
    const ep = endpoint || 'reportPerformance';
    const path = `${BASE_PATH}/${adAccountNo}/stats/${ep}?${search}`;
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
          // Naver의 실제 에러 메시지를 같이 노출 (권한 부족 vs 인증 만료 구분)
          let detail = '';
          try {
            const j = JSON.parse(body);
            detail = j.message || j.error || j.msg || JSON.stringify(j).slice(0, 200);
          } catch (_) { detail = body.slice(0, 200); }
          return reject(new Error(
            `DA 인증/권한 실패 (${res.statusCode}): ${detail || '응답 본문 없음'}\n` +
            `→ 가능 원인: (1) 쿠키 만료 → 다시 복사 필요  (2) 해당 Naver 계정이 광고계정 ${adAccountNo}에 접근 권한 없음  (3) ads.naver.com에서 해당 광고주로 전환 후 새 쿠키 복사 필요`
          ));
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
/**
 * 쿠키 문자열에서 XSRF-TOKEN 값 자동 추출
 * X-Xsrf-Token 헤더는 쿠키의 XSRF-TOKEN 값과 동일해야 함 (Naver CSRF 정책)
 */
function extractXsrfFromCookie(cookie) {
  if (!cookie) return '';
  const m = cookie.match(/XSRF-TOKEN=([^;]+)/);
  return m ? m[1].trim() : '';
}

async function fetchReportPerformance(args) {
  const {
    adAccountNo, cookie,
    startDate, endDate,
    reportAdUnit = 'CAMPAIGN',
    dateUnit, // 'TOTAL' | 'DAY' | 'WEEK' | 'MONTH' | 'HOUR'
    pageSize = 100,
    maxPages = 50,
    refererPath,
  } = args;

  if (!cookie) throw new Error('DA 쿠키가 등록되지 않았습니다. 광고주 설정에서 ads.naver.com 쿠키를 입력해주세요.');
  if (!adAccountNo) throw new Error('DA 광고계정 번호 누락');

  // 쿠키에서 XSRF-TOKEN 자동 추출 (별도 입력 불필요)
  const xsrfToken = args.xsrfToken || extractXsrfFromCookie(cookie);
  if (!xsrfToken) throw new Error('쿠키에 XSRF-TOKEN이 포함되지 않았습니다. 쿠키를 다시 복사해서 등록해주세요.');

  const allRows = [];
  let pageNumber = 1;
  let totalPage = 1;
  do {
    const params = {
      startDate, endDate,
      reportAdUnit,
      reportFilterListString: '[]',
      pageNumber: String(pageNumber),
      pageSize: String(pageSize),
    };
    if (dateUnit) params.reportDateUnit = dateUnit;
    const json = await fetchOnce(adAccountNo, params, cookie, xsrfToken, refererPath, 'reportPerformance');
    const list = json.reportPerformanceDetailResponseList || [];
    allRows.push(...list);
    totalPage = json.totalPage || 1;
    pageNumber++;
    if (pageNumber > maxPages) break;
  } while (pageNumber <= totalPage);

  return allRows;
}

/**
 * 브레이크다운 (성별/연령/매체) 호출 — reportPerformanceDetail 엔드포인트
 *
 * @param {object} args
 *   adAccountNo, cookie
 *   startDate, endDate
 *   reportDimension: 'TOTAL'|'AGE'|'GENDER'|'AGE_AND_GENDER'|'DEVICE'|'DEVICE_AND_OS'
 *   placeUnit: 'TOTAL'|'PLACEMENT_GROUP'|'PLACEMENT'  (생략 가능)
 *   reportAdUnit: 보통 'AD_ACCOUNT'
 */
async function fetchReportPerformanceDetail(args) {
  const {
    adAccountNo, cookie, adUnitNo,
    startDate, endDate,
    reportAdUnit = 'AD_ACCOUNT',
    reportDimension = 'TOTAL',
    placeUnit,
    reportDateUnit = 'TOTAL',
    refererPath,
  } = args;

  if (!cookie) throw new Error('DA 쿠키가 등록되지 않았습니다.');
  if (!adAccountNo) throw new Error('DA 광고계정 번호 누락');

  const xsrfToken = args.xsrfToken || extractXsrfFromCookie(cookie);
  if (!xsrfToken) throw new Error('쿠키에 XSRF-TOKEN이 포함되지 않았습니다.');

  // AD_ACCOUNT 단위면 광고계정 번호, AD_SET/CAMPAIGN 단위면 해당 unit 번호 사용
  const effectiveAdUnitNo = adUnitNo || adAccountNo;
  const params = {
    adUnitNo: String(effectiveAdUnitNo),
    startDate, endDate,
    reportAdUnit,
    reportDateUnit,
    reportDimension,
  };
  if (placeUnit) params.placeUnit = placeUnit;

  const json = await fetchOnce(adAccountNo, params, cookie, xsrfToken, refererPath, 'reportPerformanceDetail');
  // 응답 구조는 reportPerformance와 동일하다고 가정 (rsponseList)
  // 만약 다르면 가능한 키 후보 모두 시도
  return json.reportPerformanceDetailResponseList
       || json.reportPerformanceResponseList
       || json.reportList
       || json.list
       || (Array.isArray(json) ? json : []);
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
  fetchReportPerformanceDetail,
  normalizeRow,
  extractXsrfFromCookie,
};
