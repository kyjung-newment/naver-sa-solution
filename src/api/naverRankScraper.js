/**
 * 네이버 검색결과에서 파워링크 광고 실시간 순위 조회
 * - PC: search.naver.com 에서 파워링크 섹션 파싱
 * - MO: m.ad.search.naver.com (더보기 페이지)에서 전체 광고 목록 파싱
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MO_USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/**
 * 네이버 검색결과에서 파워링크 광고 목록 조회
 * @param {string} keyword - 검색 키워드
 * @param {'PC'|'MO'} device - 디바이스 타입
 * @returns {Array<{rank: number, headline: string, description: string, displayUrl: string}>}
 */
async function getPowerLinkAds(keyword, device = 'PC') {
  const isPC = device !== 'MO';

  try {
    if (isPC) {
      return await getPcAds(keyword);
    } else {
      return await getMobileAds(keyword);
    }
  } catch (err) {
    console.error(`검색결과 파싱 오류 [${keyword}/${device}]:`, err.message);
    return [];
  }
}

/**
 * PC 검색결과에서 파워링크 광고 파싱
 */
async function getPcAds(keyword) {
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

  // PC 파워링크: #power_link_body li.lst
  const adItems = $('#power_link_body li.lst, .ad_section li.lst');
  adItems.each((idx, el) => {
    const $el = $(el);
    const headline = $el.find('.lnk_tit, .tit_wrap a, .lnk_head').first().text().trim();
    const description = $el.find('.ad_dsc_inner, .dsc_wrap, .lnk_txt').first().text().trim();
    const displayUrl = $el.find('.lnk_url, .url_area .url').first().text().trim();

    if (headline) {
      rank++;
      ads.push({
        rank,
        headline,
        description,
        displayUrl: cleanUrl(displayUrl),
      });
    }
  });

  // fallback: onclick r= 파라미터
  if (ads.length === 0) {
    $('[onclick*="pwl_nop"]').each((idx, el) => {
      const onclick = $(el).attr('onclick') || '';
      const rMatch = onclick.match(/r=(\d+)/);
      const r = rMatch ? parseInt(rMatch[1]) : 0;
      const $li = $(el).closest('li');
      const headline = $li.find('.lnk_tit, .tit_wrap a').first().text().trim();
      const displayUrl = $li.find('.lnk_url, .url_area .url').first().text().trim();
      if (headline && r > 0 && !ads.find(a => a.rank === r)) {
        ads.push({ rank: r, headline, description: '', displayUrl: cleanUrl(displayUrl) });
      }
    });
    ads.sort((a, b) => a.rank - b.rank);
  }

  return ads;
}

/**
 * 모바일 검색결과에서 파워링크 광고 파싱
 * m.ad.search.naver.com (더보기 페이지)에서 전체 목록 조회
 */
async function getMobileAds(keyword) {
  // 더보기 페이지 (전체 파워링크 목록)
  const response = await axios.get('https://m.ad.search.naver.com/search.naver', {
    params: { where: 'm_expd', query: keyword },
    headers: {
      'User-Agent': MO_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': `https://m.search.naver.com/search.naver?where=m&query=${encodeURIComponent(keyword)}`,
    },
    timeout: 10000,
  });

  const $ = cheerio.load(response.data);
  const ads = [];
  let rank = 0;

  // 모바일 더보기 페이지의 광고 항목
  // 다양한 셀렉터로 시도
  const selectors = [
    '.lst_ad > li',
    '.ad_lst > li',
    '.search_list > li',
    '[class*="item"]',
    'li[class*="ad"]',
    'section li',
    '.inner li',
  ];

  let adItems = $([]);
  for (const sel of selectors) {
    adItems = $(sel);
    if (adItems.length > 0) break;
  }

  // 광범위 fallback: 광고주 URL이 포함된 블록 찾기
  if (adItems.length === 0) {
    // URL 패턴으로 광고 블록 찾기
    const urlEls = $('a[href*="ad.search.naver"], [class*="url"], .url');
    if (urlEls.length > 0) {
      urlEls.each((idx, el) => {
        const $container = $(el).closest('li, article, section, div[class*="item"], div[class*="ad"]');
        if ($container.length && !ads.find(a => a.headline === $container.text().trim().slice(0, 30))) {
          const headline = $container.find('a[class*="tit"], .tit, strong, h3, h2').first().text().trim();
          const displayUrl = $(el).text().trim();
          if (headline && displayUrl) {
            rank++;
            ads.push({ rank, headline, description: '', displayUrl: cleanUrl(displayUrl) });
          }
        }
      });
    }
  } else {
    adItems.each((idx, el) => {
      const $el = $(el);
      const headline = $el.find('a[class*="tit"], .tit, strong, h3, h2, .tit_area a').first().text().trim();
      const displayUrl = $el.find('[class*="url"], .url, .lnk_url').first().text().trim();
      const description = $el.find('[class*="desc"], .dsc, .ad_dsc, p').first().text().trim();

      if (headline && headline.length > 1) {
        rank++;
        ads.push({ rank, headline, description, displayUrl: cleanUrl(displayUrl) });
      }
    });
  }

  // 최종 fallback: 전체 HTML에서 displayUrl 패턴 매칭
  if (ads.length === 0) {
    console.log(`  📡 모바일 더보기 파싱 실패, HTML 길이: ${response.data.length}`);
    // raw HTML 로깅 (디버깅용, 앞부분만)
    const htmlSnippet = response.data.substring(0, 2000);
    console.log(`  HTML snippet: ${htmlSnippet.replace(/\n/g, ' ').substring(0, 500)}`);
  }

  return ads;
}

/**
 * URL 정리
 */
function cleanUrl(url) {
  return (url || '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .trim();
}

/**
 * 특정 광고주의 광고 순위를 찾기
 * @param {string} keyword - 검색 키워드
 * @param {'PC'|'MO'} device - 디바이스
 * @param {string} siteUrl - 광고주 사이트 URL (display_url 매칭용)
 * @returns {{rank: number, totalAds: number, ads: Array, matched: object|null}}
 */
async function findAdRank(keyword, device, siteUrl) {
  const ads = await getPowerLinkAds(keyword, device);
  if (!ads.length) return { rank: 0, totalAds: 0, ads: [], matched: null };

  const targetDomain = cleanUrl(siteUrl).toLowerCase();

  // 도메인 매칭으로 광고 찾기
  const matched = ads.find(ad => {
    const adDomain = (ad.displayUrl || '').toLowerCase();
    // 정확한 도메인 매칭 또는 부분 매칭
    return adDomain === targetDomain
      || adDomain.includes(targetDomain)
      || targetDomain.includes(adDomain);
  });

  return {
    rank: matched ? matched.rank : 0,
    totalAds: ads.length,
    ads,
    matched,
  };
}

module.exports = { getPowerLinkAds, findAdRank };
