/**
 * 네이버 쇼핑검색 광고 실시간 순위 조회
 * - 쇼핑탭(shopping.naver.com)에서 검색하여 특정 상품의 광고 순위 파악
 * - PC / MO 모두 지원
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 네이버 쇼핑 검색결과에서 광고 상품 목록 조회
 * @param {string} keyword - 검색 키워드
 * @param {'PC'|'MO'} device - 디바이스 타입
 * @returns {Array<{rank: number, title: string, price: string, mallName: string, url: string, isAd: boolean}>}
 */
async function getShoppingAds(keyword, device = 'MO') {
  const isPC = device !== 'MO';

  try {
    if (isPC) {
      return await getPcShoppingAds(keyword);
    } else {
      return await getMobileShoppingAds(keyword);
    }
  } catch (err) {
    console.error(`쇼핑검색 파싱 오류 [${keyword}/${device}]:`, err.message);
    return [];
  }
}

/**
 * PC 쇼핑 검색결과 파싱
 */
async function getPcShoppingAds(keyword) {
  const response = await axios.get('https://search.naver.com/search.naver', {
    params: { where: 'nexearch', query: keyword, sm: 'tab_sht', nso: '', cat_id: '' },
    headers: {
      'User-Agent': PC_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    timeout: 10000,
  });

  const $ = cheerio.load(response.data);
  const ads = [];
  let rank = 0;

  // 쇼핑 영역의 광고 상품 (통합검색에서 쇼핑 섹션)
  // 네이버 쇼핑탭 직접 조회
  const response2 = await axios.get('https://search.shopping.naver.com/search/all', {
    params: { query: keyword, sort: 'rel' },
    headers: {
      'User-Agent': PC_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    timeout: 10000,
  });

  const $2 = cheerio.load(response2.data);

  // 광고 상품 파싱 (쇼핑 검색 결과)
  // 광고 상품은 보통 "광고" 표시가 있음
  $2('[class*="adProduct"], [class*="ad_product"], [data-ad-id]').each((idx, el) => {
    const $el = $2(el);
    const title = $el.find('[class*="tit"], a[class*="name"], [class*="product_title"]').first().text().trim();
    const price = $el.find('[class*="price"], [class*="num"]').first().text().trim();
    const mallName = $el.find('[class*="mall"], [class*="seller"]').first().text().trim();
    const linkEl = $el.find('a[href]').first();
    const url = linkEl.attr('href') || '';

    if (title) {
      rank++;
      ads.push({ rank, title, price, mallName, url, isAd: true });
    }
  });

  // 일반 상품도 포함 (순위 파악용)
  if (ads.length === 0) {
    $2('[class*="product_item"], [class*="basicList_item"]').each((idx, el) => {
      const $el = $2(el);
      const title = $el.find('[class*="tit"], [class*="name"], a[title]').first().text().trim() || $el.find('a[title]').first().attr('title') || '';
      const price = $el.find('[class*="price"] [class*="num"], [class*="price_num"]').first().text().trim();
      const mallName = $el.find('[class*="mall"], [class*="seller"]').first().text().trim();
      const isAd = $el.find('[class*="ad"], [class*="label_ad"]').length > 0 || $el.attr('class')?.includes('ad');
      const linkEl = $el.find('a[href]').first();
      const url = linkEl.attr('href') || '';

      if (title && title.length > 1) {
        rank++;
        ads.push({ rank, title, price, mallName, url, isAd });
      }
    });
  }

  return ads;
}

/**
 * 모바일 쇼핑 검색결과 파싱
 */
async function getMobileShoppingAds(keyword) {
  const response = await axios.get('https://msearch.shopping.naver.com/search/all', {
    params: { query: keyword, sort: 'rel' },
    headers: {
      'User-Agent': MO_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    timeout: 10000,
  });

  const $ = cheerio.load(response.data);
  const ads = [];
  let rank = 0;

  // 모바일 쇼핑 상품 목록
  $('[class*="product_item"], [class*="adProduct"], [class*="basicList"]').each((idx, el) => {
    const $el = $(el);
    const title = $el.find('[class*="tit"], [class*="name"], a[title]').first().text().trim() || $el.find('a[title]').first().attr('title') || '';
    const price = $el.find('[class*="price"] [class*="num"], [class*="price_num"]').first().text().trim();
    const mallName = $el.find('[class*="mall"], [class*="seller"]').first().text().trim();
    const isAd = $el.find('[class*="ad"], [class*="label_ad"]').length > 0;
    const linkEl = $el.find('a[href]').first();
    const url = linkEl.attr('href') || '';

    if (title && title.length > 1) {
      rank++;
      ads.push({ rank, title, price, mallName, url, isAd });
    }
  });

  return ads;
}

/**
 * URL에서 도메인/경로 추출 (매칭용)
 */
function extractDomain(rawUrl) {
  if (!rawUrl) return '';
  try {
    // 전체 URL인 경우
    if (rawUrl.startsWith('http')) {
      const u = new URL(rawUrl);
      return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
    }
    return rawUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').trim();
  } catch {
    return rawUrl.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').trim();
  }
}

/**
 * 특정 상품의 쇼핑검색 순위 찾기
 * @param {string} keyword - 검색 키워드
 * @param {'PC'|'MO'} device - 디바이스
 * @param {string} productUrl - 상품 URL (매칭용)
 * @returns {{rank: number, totalAds: number, ads: Array, matched: object|null}}
 */
async function findShoppingRank(keyword, device, productUrl) {
  const ads = await getShoppingAds(keyword, device);
  if (!ads.length) return { rank: 0, totalAds: 0, ads: [], matched: null };

  const targetDomain = extractDomain(productUrl).toLowerCase();
  if (!targetDomain) return { rank: 0, totalAds: ads.length, ads, matched: null };

  // URL 기반 매칭
  const matched = ads.find(ad => {
    const adDomain = extractDomain(ad.url).toLowerCase();
    if (!adDomain) return false;

    // 정확 매칭
    if (adDomain === targetDomain) return true;
    // 도메인 포함 매칭
    if (adDomain.includes(targetDomain) || targetDomain.includes(adDomain)) return true;
    // smartstore 경로 매칭
    const targetParts = targetDomain.split('/');
    const adParts = adDomain.split('/');
    if (targetParts[0] === adParts[0] && targetParts.length > 1 && adParts.length > 1) {
      return targetParts[1] === adParts[1]; // 같은 스토어
    }
    return false;
  });

  // 상품명 기반 매칭 (URL 매칭 실패 시)
  // mall name 으로도 시도
  let altMatched = null;
  if (!matched && productUrl) {
    const storeName = productUrl.match(/smartstore\.naver\.com\/([^\/]+)/)?.[1]?.toLowerCase();
    if (storeName) {
      altMatched = ads.find(ad => {
        const adStore = ad.url?.match(/smartstore\.naver\.com\/([^\/]+)/)?.[1]?.toLowerCase();
        return adStore && adStore === storeName;
      });
    }
  }

  const finalMatch = matched || altMatched;
  return {
    rank: finalMatch ? finalMatch.rank : 0,
    totalAds: ads.length,
    ads,
    matched: finalMatch,
  };
}

module.exports = { getShoppingAds, findShoppingRank };
