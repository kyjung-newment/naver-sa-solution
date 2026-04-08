/**
 * 네이버 쇼핑검색 광고 순위 조회
 *
 * 접근 전략:
 * 1차: search.shopping.naver.com API (JSON) — 쇼핑 전용 검색
 * 2차: search.naver.com 통합검색 HTML — 가격비교 섹션
 * 3차: __NEXT_DATA__ script 태그 파싱 — SSR 데이터
 *
 * 매칭: 상점명(mallName) 기반 (광고 클릭 URL이 달라서 URL 매칭 불가)
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 쇼핑 상품 목록 조회 (다중 소스 시도)
 */
async function getShoppingAds(keyword, device = 'PC') {
  const isPC = device !== 'MO';
  const userAgent = isPC ? PC_USER_AGENT : MO_USER_AGENT;

  // 1차: 네이버 쇼핑 검색 API (JSON 응답)
  try {
    const ads = await fetchShoppingApi(keyword, userAgent);
    if (ads.length > 0) {
      console.log(`  🛒 [${device}] 쇼핑 API: ${ads.length}개 발견`);
      return ads;
    }
  } catch (e) {
    console.log(`  🛒 쇼핑 API 실패: ${e.message}`);
  }

  // 2차: 네이버 쇼핑 검색페이지 HTML (__NEXT_DATA__ 파싱)
  try {
    const ads = await fetchShoppingPage(keyword, isPC, userAgent);
    if (ads.length > 0) {
      console.log(`  🛒 [${device}] 쇼핑 페이지: ${ads.length}개 발견`);
      return ads;
    }
  } catch (e) {
    console.log(`  🛒 쇼핑 페이지 실패: ${e.message}`);
  }

  // 3차: 통합검색 페이지에서 쇼핑 섹션 추출
  try {
    const ads = await fetchIntegratedSearch(keyword, isPC, userAgent);
    if (ads.length > 0) {
      console.log(`  🛒 [${device}] 통합검색: ${ads.length}개 발견`);
      return ads;
    }
  } catch (e) {
    console.log(`  🛒 통합검색 실패: ${e.message}`);
  }

  console.log(`  🛒 [${device}] 쇼핑검색 파싱 실패 (모든 소스)`);
  return [];
}

/**
 * 1차: 네이버 쇼핑 검색 API
 * search.shopping.naver.com 에서 JSON 데이터 가져오기
 */
async function fetchShoppingApi(keyword, userAgent) {
  // 쇼핑 검색 API 엔드포인트들 시도
  const endpoints = [
    {
      url: 'https://search.shopping.naver.com/api/search/all',
      params: { query: keyword, sort: 'rel', pagingIndex: 1, pagingSize: 40, viewType: 'list' },
    },
    {
      url: 'https://search.shopping.naver.com/search/all',
      params: { query: keyword, sort: 'rel' },
      isHtml: true,
    },
  ];

  for (const ep of endpoints) {
    try {
      const response = await axios.get(ep.url, {
        params: ep.params,
        headers: {
          'User-Agent': userAgent,
          'Accept': ep.isHtml ? 'text/html,application/xhtml+xml' : 'application/json,text/plain',
          'Accept-Language': 'ko-KR,ko;q=0.9',
          'Referer': 'https://search.shopping.naver.com/',
        },
        timeout: 10000,
      });

      if (ep.isHtml) {
        // HTML에서 __NEXT_DATA__ 파싱
        return parseNextData(response.data);
      } else {
        // JSON 응답 파싱
        return parseShoppingApiJson(response.data);
      }
    } catch (e) {
      continue;
    }
  }

  return [];
}

/**
 * JSON API 응답 파싱
 */
function parseShoppingApiJson(data) {
  const ads = [];
  let rank = 0;

  // shoppingResult.products 배열에서 추출
  const products = data?.shoppingResult?.products
    || data?.products
    || data?.items
    || [];

  for (const p of products) {
    rank++;
    ads.push({
      rank,
      title: p.productTitle || p.title || p.name || '',
      price: String(p.price || p.lowPrice || ''),
      mallName: p.mallName || p.shopName || p.mallProductVendorName || '',
      url: p.mallProductUrl || p.productUrl || p.crUrl || '',
      isAd: !!(p.adId || p.isAd || p.adcrUrl || p.type === 'ad'),
    });
  }

  return ads;
}

/**
 * 2차: 쇼핑 검색 페이지 HTML에서 __NEXT_DATA__ 파싱
 */
async function fetchShoppingPage(keyword, isPC, userAgent) {
  const url = isPC
    ? 'https://search.shopping.naver.com/search/all'
    : 'https://msearch.shopping.naver.com/search/all';

  const response = await axios.get(url, {
    params: { query: keyword, sort: 'rel' },
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    timeout: 10000,
  });

  return parseNextData(response.data);
}

/**
 * __NEXT_DATA__ 스크립트 태그에서 상품 데이터 추출
 */
function parseNextData(html) {
  const ads = [];
  let rank = 0;

  // __NEXT_DATA__ JSON 추출
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const products = findProducts(nextData);
      for (const p of products) {
        rank++;
        ads.push({
          rank,
          title: p.productTitle || p.title || p.name || '',
          price: String(p.price || p.lowPrice || p.pcPrice || ''),
          mallName: p.mallName || p.shopName || p.mallProductVendorName || '',
          url: p.mallProductUrl || p.productUrl || p.crUrl || '',
          isAd: !!(p.adId || p.isAd || p.adcrUrl || p.type === 'ad' || p.advertBidType),
        });
      }
      if (ads.length > 0) return ads;
    } catch (e) {
      console.log('  __NEXT_DATA__ 파싱 오류:', e.message);
    }
  }

  // fallback: JSON 패턴 매칭 (mallName + productTitle)
  const jsonChunks = html.match(/\{[^{}]*"mallName"\s*:\s*"[^"]*"[^{}]*"productTitle"\s*:\s*"[^"]*"[^{}]*\}/g)
    || html.match(/\{[^{}]*"productTitle"\s*:\s*"[^"]*"[^{}]*"mallName"\s*:\s*"[^"]*"[^{}]*\}/g)
    || [];

  for (const chunk of jsonChunks) {
    try {
      // 불완전한 JSON이므로 필드만 추출
      const mallName = chunk.match(/"mallName"\s*:\s*"([^"]*)"/)?.[1] || '';
      const title = chunk.match(/"productTitle"\s*:\s*"([^"]*)"/)?.[1] || '';
      const price = chunk.match(/"price"\s*:\s*"?(\d+)"?/)?.[1] || '';
      const isAd = chunk.includes('"adId"') || chunk.includes('"adcrUrl"') || chunk.includes('"advertBidType"');

      if (mallName && title) {
        rank++;
        ads.push({ rank, title, price, mallName, url: '', isAd });
      }
    } catch (e) { continue; }
  }

  return ads;
}

/**
 * 중첩 JSON에서 products 배열 찾기
 */
function findProducts(obj, depth = 0) {
  if (depth > 8 || !obj) return [];
  if (Array.isArray(obj)) {
    // 배열 중 productTitle이 있는 객체가 포함된 배열이면 반환
    if (obj.length > 0 && obj[0] && (obj[0].productTitle || obj[0].mallName)) {
      return obj;
    }
    for (const item of obj) {
      const found = findProducts(item, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }
  if (typeof obj === 'object') {
    // products, items, list 등의 키 우선 검색
    for (const key of ['products', 'items', 'list', 'shoppingResult', 'data', 'result']) {
      if (obj[key]) {
        const found = findProducts(obj[key], depth + 1);
        if (found.length > 0) return found;
      }
    }
    // 나머지 키 검색
    for (const key of Object.keys(obj)) {
      if (['products', 'items', 'list', 'shoppingResult', 'data', 'result'].includes(key)) continue;
      const found = findProducts(obj[key], depth + 1);
      if (found.length > 0) return found;
    }
  }
  return [];
}

/**
 * 3차: 네이버 통합검색에서 쇼핑 섹션 추출
 */
async function fetchIntegratedSearch(keyword, isPC, userAgent) {
  const url = isPC ? 'https://search.naver.com/search.naver' : 'https://m.search.naver.com/search.naver';
  const params = isPC
    ? { where: 'nexearch', query: keyword }
    : { where: 'm', query: keyword };

  const response = await axios.get(url, {
    params,
    headers: {
      'User-Agent': userAgent,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    timeout: 10000,
  });

  const $ = cheerio.load(response.data);
  const ads = [];
  let rank = 0;

  // 쇼핑 영역 셀렉터들
  const selectors = [
    '[data-cr-area*="nshp"] li, [data-cr-area*="nshp"] [class*="item"]',
    '[class*="shop_list"] li',
    '[class*="price_compare"] li',
    '[class*="mall_product"]',
    '[class*="sp_"] li',
  ];

  let items = $([]);
  for (const sel of selectors) {
    const found = $(sel);
    if (found.length > 0) { items = found; break; }
  }

  items.each((idx, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    const title = $el.find('[class*="tit"], [class*="name"], a[title]').first().text().trim()
      || $el.find('a[title]').first().attr('title') || '';
    const price = $el.find('[class*="price"]').first().text().trim();
    const isAd = /광고[①②③④⑤⑥⑦⑧⑨⑩]/.test(text);
    const linkEl = $el.find('a[href]').first();
    const url = linkEl.attr('href') || '';

    // 상점명 추출
    let mallName = '';
    $el.find('[class*="mall"], [class*="seller"], [class*="store"], [class*="name"]').each((i, nameEl) => {
      const t = $(nameEl).text().replace(/광고[①②③④⑤⑥⑦⑧⑨⑩]?/g, '').trim();
      if (t && t.length < 30 && t.length > 1 && !t.includes('원') && !t.includes('배송')) {
        if (!mallName) mallName = t;
      }
    });

    if (title && title.length > 1) {
      rank++;
      ads.push({ rank, title, price, mallName, url, isAd });
    }
  });

  // fallback: script 데이터
  if (ads.length === 0) {
    return parseNextData(response.data);
  }

  return ads;
}

/**
 * smartstore URL에서 스토어ID 추출
 */
function extractStoreId(url) {
  if (!url) return '';
  const match = url.match(/smartstore\.naver\.com\/([^\/\?#]+)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * 특정 상품의 쇼핑검색 순위 찾기
 * 매칭 우선순위: 1) 상점명 매칭 2) smartstore ID 매칭 3) URL 포함 매칭
 */
async function findShoppingRank(keyword, device, productUrl) {
  const ads = await getShoppingAds(keyword, device);
  if (!ads.length) return { rank: 0, totalAds: 0, ads: [], matched: null };

  let matched = null;
  const targetStoreId = extractStoreId(productUrl);

  // 1차: smartstore ID가 mallName에 포함된 경우 (예: siseongot → 시성갓)
  // 또는 mallProductUrl에 같은 smartstore ID가 있는 경우
  if (targetStoreId) {
    matched = ads.find(ad => {
      const adStoreId = extractStoreId(ad.url);
      return adStoreId && adStoreId === targetStoreId;
    });
  }

  // 2차: productUrl 도메인 부분 매칭
  if (!matched && productUrl) {
    const cleanTarget = productUrl.toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\?.*$/, '')
      .replace(/\/$/, '');

    matched = ads.find(ad => {
      if (!ad.url) return false;
      const cleanAd = ad.url.toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\?.*$/, '')
        .replace(/\/$/, '');
      // smartstore 경로 매칭
      if (cleanTarget.includes('smartstore.naver.com') && cleanAd.includes('smartstore.naver.com')) {
        const targetPath = cleanTarget.split('smartstore.naver.com/')[1]?.split('/')[0];
        const adPath = cleanAd.split('smartstore.naver.com/')[1]?.split('/')[0];
        return targetPath && adPath && targetPath === adPath;
      }
      return cleanAd.includes(cleanTarget) || cleanTarget.includes(cleanAd);
    });
  }

  // 3차: mallName에 URL의 일부가 포함된 경우
  if (!matched && targetStoreId) {
    matched = ads.find(ad => {
      if (!ad.mallName) return false;
      const mall = ad.mallName.toLowerCase().replace(/\s+/g, '');
      return mall.includes(targetStoreId) || targetStoreId.includes(mall);
    });
  }

  return {
    rank: matched ? matched.rank : 0,
    totalAds: ads.length,
    ads,
    matched,
  };
}

module.exports = { getShoppingAds, findShoppingRank };
