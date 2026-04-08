/**
 * 네이버 통합검색 "네이버 가격비교" 섹션에서 쇼핑 광고 순위 조회
 * - PC: search.naver.com 통합검색 → "네이버 가격비교" 영역 파싱
 * - MO: m.search.naver.com 통합검색 → 쇼핑 영역 파싱
 * - 광고 표시(광고①) 있는 상품과 일반 상품 구분
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 네이버 통합검색에서 쇼핑(가격비교) 상품 목록 조회
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
 * PC 통합검색에서 "네이버 가격비교" 섹션 파싱
 */
async function getPcShoppingAds(keyword) {
  const response = await axios.get('https://search.naver.com/search.naver', {
    params: { where: 'nexearch', query: keyword },
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

  // 네이버 가격비교 / 쇼핑 영역 셀렉터들
  const shoppingSelectors = [
    // 가격비교 영역 내 상품 아이템
    '[class*="shop_list"] [class*="product"]',
    '[class*="price_compare"] [class*="product"]',
    '[class*="shopping"] [class*="item"]',
    '[class*="mall_product"]',
    // SSR 영역
    '[data-cr-area*="nshp"] li',
    '[data-cr-area*="shop"] li',
    '[class*="sp_list"] li',
    // 일반 상품 카드
    '[class*="ad_shopping"] li',
  ];

  let items = $([]);
  for (const sel of shoppingSelectors) {
    const found = $(sel);
    if (found.length > 0) {
      items = found;
      console.log(`  🛒 PC 쇼핑 셀렉터 매칭: "${sel}" → ${found.length}개`);
      break;
    }
  }

  items.each((idx, el) => {
    const $el = $(el);
    const title = $el.find('[class*="tit"], [class*="name"], a[title]').first().text().trim()
      || $el.find('a[title]').first().attr('title') || '';
    const price = $el.find('[class*="price"], [class*="num"]').first().text().trim();
    const mallName = extractMallName($el, $);
    const isAd = checkIsAd($el, $);
    const linkEl = $el.find('a[href]').first();
    const url = linkEl.attr('href') || '';

    if (title && title.length > 1) {
      rank++;
      ads.push({ rank, title, price, mallName, url, isAd });
    }
  });

  // fallback: 전체 HTML에서 쇼핑 광고 데이터 추출 (JSON-LD / script 태그)
  if (ads.length === 0) {
    const scriptAds = extractFromScripts($, response.data);
    if (scriptAds.length > 0) {
      console.log(`  🛒 PC script 태그에서 ${scriptAds.length}개 발견`);
      return scriptAds;
    }
  }

  if (ads.length === 0) {
    console.log(`  🛒 PC 쇼핑 파싱 실패, HTML 길이: ${response.data.length}`);
  }

  return ads;
}

/**
 * 모바일 통합검색에서 쇼핑/가격비교 섹션 파싱
 */
async function getMobileShoppingAds(keyword) {
  const response = await axios.get('https://m.search.naver.com/search.naver', {
    params: { where: 'm', query: keyword },
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

  // 모바일 통합검색 쇼핑 영역
  const mobileSelectors = [
    '[data-cr-area*="nshp"] li',
    '[data-cr-area*="shop"] li',
    '[class*="flick_bx"] [class*="item"]',
    '[class*="shopping"] [class*="item"]',
    '[class*="price_compare"] li',
    '[class*="sp_"] li[class*="item"]',
    '[class*="shop_"] li',
    '[class*="mall_product"]',
  ];

  let items = $([]);
  for (const sel of mobileSelectors) {
    const found = $(sel);
    if (found.length > 0) {
      items = found;
      console.log(`  🛒 MO 쇼핑 셀렉터 매칭: "${sel}" → ${found.length}개`);
      break;
    }
  }

  items.each((idx, el) => {
    const $el = $(el);
    const title = $el.find('[class*="tit"], [class*="name"], a[title]').first().text().trim()
      || $el.find('a[title]').first().attr('title') || '';
    const price = $el.find('[class*="price"], [class*="num"]').first().text().trim();
    const mallName = extractMallName($el, $);
    const isAd = checkIsAd($el, $);
    const linkEl = $el.find('a[href]').first();
    const url = linkEl.attr('href') || '';

    if (title && title.length > 1) {
      rank++;
      ads.push({ rank, title, price, mallName, url, isAd });
    }
  });

  // fallback: script 태그에서 데이터 추출
  if (ads.length === 0) {
    const scriptAds = extractFromScripts($, response.data);
    if (scriptAds.length > 0) {
      console.log(`  🛒 MO script 태그에서 ${scriptAds.length}개 발견`);
      return scriptAds;
    }
  }

  if (ads.length === 0) {
    console.log(`  🛒 MO 쇼핑 파싱 실패, HTML 길이: ${response.data.length}`);
  }

  return ads;
}

/**
 * 상점명 추출 헬퍼
 */
function extractMallName($el, $) {
  // 다양한 셀렉터로 상점명 추출
  const selectors = [
    '[class*="mall"]',
    '[class*="seller"]',
    '[class*="store"]',
    '[class*="shop_name"]',
    '[class*="src_area"] a',
    '[class*="info"] [class*="name"]',
  ];
  for (const sel of selectors) {
    const text = $el.find(sel).first().text().trim();
    if (text && text.length > 0 && text.length < 50) {
      // "광고" 텍스트 제거
      return text.replace(/광고[①②③④⑤⑥⑦⑧⑨⑩]?/g, '').trim();
    }
  }
  return '';
}

/**
 * 광고 여부 체크
 */
function checkIsAd($el, $) {
  const fullText = $el.text();
  if (/광고[①②③④⑤⑥⑦⑧⑨⑩]/.test(fullText)) return true;
  if ($el.find('[class*="ad"]').length > 0) return true;
  if ($el.attr('class')?.includes('ad')) return true;
  if ($el.find('[class*="badge_ad"], [class*="label_ad"], [class*="ico_ad"]').length > 0) return true;
  return false;
}

/**
 * script 태그에서 쇼핑 데이터 추출 (SSR 이후 hydration 데이터)
 */
function extractFromScripts($, html) {
  const ads = [];
  let rank = 0;

  // __NEXT_DATA__ 또는 쇼핑 관련 JSON 데이터 찾기
  $('script').each((idx, el) => {
    const text = $(el).html() || '';

    // 쇼핑 상품 데이터가 포함된 JSON 패턴 찾기
    const patterns = [
      /"mallName"\s*:\s*"([^"]+)".*?"productTitle"\s*:\s*"([^"]+)".*?"price"\s*:\s*"?(\d+)"?/g,
      /"shopName"\s*:\s*"([^"]+)".*?"title"\s*:\s*"([^"]+)".*?"price"\s*:\s*"?(\d+)"?/g,
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        rank++;
        ads.push({
          rank,
          title: match[2],
          price: match[3],
          mallName: match[1],
          url: '',
          isAd: text.includes('"adId"') || text.includes('"ad"'),
        });
      }
    }
  });

  // 더 간단한 패턴: mallName과 productTitle 쌍 찾기
  if (ads.length === 0) {
    const mallMatches = html.match(/"mallName"\s*:\s*"[^"]+"/g) || [];
    const titleMatches = html.match(/"(?:productTitle|title)"\s*:\s*"[^"]+"/g) || [];

    if (mallMatches.length > 0 && titleMatches.length > 0) {
      const count = Math.min(mallMatches.length, titleMatches.length);
      for (let i = 0; i < count; i++) {
        const mall = mallMatches[i].match(/"mallName"\s*:\s*"([^"]+)"/)?.[1] || '';
        const title = titleMatches[i].match(/"(?:productTitle|title)"\s*:\s*"([^"]+)"/)?.[1] || '';
        if (mall && title) {
          rank++;
          ads.push({ rank, title, price: '', mallName: mall, url: '', isAd: false });
        }
      }
    }
  }

  return ads;
}

/**
 * URL에서 도메인/경로 추출 (매칭용)
 */
function extractDomain(rawUrl) {
  if (!rawUrl) return '';
  try {
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
 * smartstore URL에서 스토어ID 추출
 * 예: https://smartstore.naver.com/postermakers → postermakers
 */
function extractStoreId(url) {
  if (!url) return '';
  const match = url.match(/smartstore\.naver\.com\/([^\/\?#]+)/i);
  return match ? match[1].toLowerCase() : '';
}

/**
 * 특정 상품의 쇼핑검색 순위 찾기
 * 매칭 방법: 1) URL 도메인 매칭 2) 스토어ID 매칭 3) 상점명 매칭
 * @param {string} keyword - 검색 키워드
 * @param {'PC'|'MO'} device - 디바이스
 * @param {string} productUrl - 상품/스토어 URL (매칭용)
 * @returns {{rank: number, totalAds: number, ads: Array, matched: object|null}}
 */
async function findShoppingRank(keyword, device, productUrl) {
  const ads = await getShoppingAds(keyword, device);
  if (!ads.length) return { rank: 0, totalAds: 0, ads: [], matched: null };

  let matched = null;

  // 1차: URL 도메인 매칭
  const targetDomain = extractDomain(productUrl).toLowerCase();
  if (targetDomain) {
    matched = ads.find(ad => {
      const adDomain = extractDomain(ad.url).toLowerCase();
      if (!adDomain) return false;
      if (adDomain === targetDomain) return true;
      if (adDomain.includes(targetDomain) || targetDomain.includes(adDomain)) return true;
      return false;
    });
  }

  // 2차: smartstore 스토어ID 매칭 (URL과 mallName 비교)
  if (!matched) {
    const targetStoreId = extractStoreId(productUrl);
    if (targetStoreId) {
      matched = ads.find(ad => {
        // 광고 링크 URL에서 스토어ID 추출
        const adStoreId = extractStoreId(ad.url);
        if (adStoreId && adStoreId === targetStoreId) return true;
        // mallName에서 매칭 (예: "위드로잉 스토어" vs "postermakers")
        // smartstore URL 경로와 상점명이 일치하는 경우
        return false;
      });
    }
  }

  // 3차: 상점명(mallName) 직접 매칭
  if (!matched && productUrl) {
    // 스토어명이 URL에 포함된 경우
    const urlParts = productUrl.toLowerCase().split('/').filter(Boolean);
    matched = ads.find(ad => {
      if (!ad.mallName) return false;
      const mallLower = ad.mallName.toLowerCase().replace(/\s+/g, '');
      // URL의 각 파트와 상점명 비교
      for (const part of urlParts) {
        const cleanPart = part.replace(/[^a-z0-9가-힣]/g, '');
        if (cleanPart.length > 2 && mallLower.includes(cleanPart)) return true;
        if (cleanPart.length > 2 && cleanPart.includes(mallLower)) return true;
      }
      return false;
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
