/**
 * 방문자 정보 파싱 모듈
 *
 * 네이버SA 광고 파라미터:
 *   n_keyword_id, n_keyword, n_campaign_id, n_adgroup_id, n_ad_id (파워링크)
 *   NaPm (네이버 광고 공통 파라미터)
 *
 * 자연검색 Referrer:
 *   https://search.naver.com/search.naver?query=키워드
 *   https://www.google.com/search?q=키워드
 */

/**
 * URL 파라미터 파싱
 */
function parseParams(url) {
  try {
    const u = new URL(url, 'http://localhost');
    const p = {};
    for (const [k, v] of u.searchParams) p[k] = v;
    return p;
  } catch {
    return {};
  }
}

/**
 * 유입 소스 & 키워드 분류
 */
function classifySource(pageUrl, referrer) {
  const pageParams = parseParams(pageUrl || '');
  const ref = referrer || '';

  // 1순위: 네이버 SA 광고 파라미터 (n_keyword_id 또는 NaPm)
  if (pageParams.n_keyword_id || pageParams.NaPm) {
    return {
      source:     'naver_sa',
      keyword:    decodeURIComponent(pageParams.n_keyword || ''),
      campaignId: pageParams.n_campaign_id || '',
      adGroupId:  pageParams.n_adgroup_id  || '',
      keywordId:  pageParams.n_keyword_id  || '',
    };
  }

  // UTM 파라미터 (수동 태깅)
  if (pageParams.utm_source) {
    const src = pageParams.utm_source.toLowerCase();
    const medium = (pageParams.utm_medium || '').toLowerCase();
    let source = src;
    if (src === 'naver' && (medium === 'cpc' || medium === 'ppc')) source = 'naver_sa';
    else if (src === 'naver') source = 'naver_organic';
    else if (src === 'google' && medium === 'cpc') source = 'google_ads';
    return {
      source,
      keyword:    decodeURIComponent(pageParams.utm_term || pageParams.n_keyword || ''),
      campaignId: pageParams.utm_campaign || '',
      adGroupId:  '',
      keywordId:  '',
    };
  }

  // 네이버 자연 검색 referrer
  if (ref.includes('search.naver.com')) {
    const keyword = decodeURIComponent(parseParams(ref).query || '');
    return { source: 'naver_organic', keyword, campaignId: '', adGroupId: '', keywordId: '' };
  }

  // 구글
  if (ref.includes('google.com')) {
    const keyword = decodeURIComponent(parseParams(ref).q || '');
    return { source: 'google_organic', keyword, campaignId: '', adGroupId: '', keywordId: '' };
  }

  // Daum/Kakao
  if (ref.includes('daum.net') || ref.includes('kakao.com')) {
    const keyword = decodeURIComponent(parseParams(ref).q || parseParams(ref).query || '');
    return { source: 'daum', keyword, campaignId: '', adGroupId: '', keywordId: '' };
  }

  // 기타 referrer
  if (ref && !ref.includes('localhost')) {
    return { source: 'referral', keyword: '', campaignId: '', adGroupId: '', keywordId: '' };
  }

  return { source: 'direct', keyword: '', campaignId: '', adGroupId: '', keywordId: '' };
}

/**
 * 디바이스 감지
 */
function detectDevice(ua = '') {
  const u = ua.toLowerCase();
  if (/tablet|ipad/.test(u)) return 'tablet';
  if (/mobile|android|iphone/.test(u)) return 'mobile';
  return 'desktop';
}

/**
 * IP에서 지역 정보 추출 (geoip-lite 사용)
 */
function getGeoInfo(ip) {
  try {
    const geoip = require('geoip-lite');
    const geo = geoip.lookup(ip);
    return {
      country: geo?.country || '',
      city:    geo?.city    || '',
    };
  } catch {
    return { country: '', city: '' };
  }
}

/**
 * 실제 클라이언트 IP 추출 (프록시/로드밸런서 고려)
 */
function extractIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || req.ip || '';
}

/**
 * 세션 ID 생성 (쿠키 또는 신규 생성)
 */
function getSessionId(req, res) {
  const COOKIE_NAME = '_nav_sid';
  let sid = req.cookies?.[COOKIE_NAME];
  if (!sid) {
    sid = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (res) {
      res.cookie(COOKIE_NAME, sid, {
        maxAge: 30 * 60 * 1000, // 30분
        httpOnly: true,
        sameSite: 'Lax',
      });
    }
  }
  return sid;
}

module.exports = { classifySource, detectDevice, getGeoInfo, extractIp, getSessionId };
