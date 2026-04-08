/**
 * 네이버 검색결과에서 파워링크 광고 실시간 순위 조회
 * - PC: search.naver.com 에서 파워링크 섹션 파싱 (최대 15개)
 * - MO: m.search.naver.com (메인) + m.ad.search.naver.com (더보기) 파싱
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
 * m.search.naver.com (메인 통합검색) 기준 - 실제 사용자에게 보이는 순서
 * 모바일은 상위 4개만 노출됨 → 5위 이상은 "순위밖"
 */
async function getMobileAds(keyword) {
  const response = await axios.get('https://m.search.naver.com/search.naver', {
    params: { where: 'm', query: keyword },
    headers: {
      'User-Agent': MO_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
    },
    timeout: 10000,
  });

  return parseMobileHtml(response.data);
}

/**
 * 더보기 페이지 (m.ad.search.naver.com) - 전체 광고 목록 (테스트/비교용)
 */
async function getMobileAdsMore(keyword) {
  const response = await axios.get('https://m.ad.search.naver.com/search.naver', {
    params: { where: 'm', query: keyword },
    headers: {
      'User-Agent': MO_USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'ko-KR,ko;q=0.9',
      'Referer': 'https://m.search.naver.com/',
    },
    timeout: 10000,
  });

  return { ads: parseMobileHtml(response.data), html: response.data };
}

/**
 * 모바일 HTML에서 파워링크 광고 파싱 (공통)
 */
function parseMobileHtml(html) {
  const $ = cheerio.load(html);
  const ads = [];
  let rank = 0;

  const containerSelectors = [
    '[class*="powerlink"] li',
    '[id*="mobilePowerLink"] li',
    '.lst_total > li',
    '[class*="ad_area"] li',
    '[data-cr-area*="pwl"] li',
    '.lst_ad > li',
    '[class*="pow_link"] li',
    'ul li[data-cr-rank]',
  ];

  let adItems = $([]);
  for (const sel of containerSelectors) {
    const found = $(sel);
    if (found.length > 0) {
      adItems = found;
      console.log(`  📡 모바일 셀렉터 매칭: "${sel}" → ${found.length}개`);
      break;
    }
  }

  if (adItems.length === 0) {
    adItems = $('[data-cr-rank]');
    if (adItems.length > 0) {
      console.log(`  📡 data-cr-rank로 ${adItems.length}개 발견`);
    }
  }

  adItems.each((idx, el) => {
    const $el = $(el);
    const headline = $el.find('.tit, .tit_area a, a.tit, [class*="tit"] a, strong a, a[class*="link"]').first().text().trim();
    const description = $el.find('.dsc, .desc, .ad_dsc, [class*="desc"], [class*="dsc"]').first().text().trim();
    const displayUrl = $el.find('.url, .url_area .url, .lnk_url, [class*="url"]').first().text().trim();

    if (headline && headline.length > 1) {
      rank++;
      ads.push({ rank, headline, description, displayUrl: cleanUrl(displayUrl) });
    }
  });

  if (ads.length === 0) {
    $('[onclick*="pwl"]').each((idx, el) => {
      const $li = $(el).closest('li');
      const headline = $li.find('a').first().text().trim();
      const displayUrl = $li.find('[class*="url"]').first().text().trim();
      if (headline && headline.length > 1) {
        rank++;
        ads.push({ rank, headline, description: '', displayUrl: cleanUrl(displayUrl) });
      }
    });
  }

  if (ads.length === 0) {
    console.log(`  📡 모바일 파싱 실패, HTML 길이: ${html.length}`);
  }

  return ads;
}

/**
 * URL 정리 - displayUrl에서 실제 도메인만 추출
 * 예: "포스터메이커스   smartstore.naver.com/postermakers      네이버페이" → "smartstore.naver.com/postermakers"
 */
function cleanUrl(rawText) {
  if (!rawText) return '';
  // URL 패턴 매칭 (서브도메인 포함: smartstore.naver.com/path 등)
  const urlMatch = rawText.match(/([a-zA-Z0-9가-힣\-]+(?:\.[a-zA-Z0-9가-힣\-]+)*\.(?:com|co\.kr|kr|net|org|io|shop|store|me|biz|info|cc|tv|xyz)(?:\/[a-zA-Z0-9가-힣\-_.\/]*)?)/i);
  if (urlMatch) {
    return urlMatch[1]
      .replace(/^www\./, '')
      .replace(/\/$/, '')
      .trim();
  }
  // URL 패턴 없으면 원본 정리
  return rawText
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\s+네이버페이.*$/, '')
    .replace(/\s+네이버톡톡.*$/, '')
    .replace(/\s+네이버로그인.*$/, '')
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

  // 도메인 매칭으로 광고 찾기 (정밀 매칭)
  const matched = ads.find(ad => {
    const adDomain = cleanUrl(ad.displayUrl).toLowerCase();
    if (!adDomain || !targetDomain) return false;

    // 정확히 일치
    if (adDomain === targetDomain) return true;

    // smartstore 등 경로가 있는 URL은 경로까지 정확히 매칭
    if (targetDomain.includes('/') || adDomain.includes('/')) {
      return adDomain === targetDomain;
    }

    // 도메인만 비교 (경로 없는 경우)
    const adBase = adDomain.split('/')[0];
    const targetBase = targetDomain.split('/')[0];
    return adBase === targetBase;
  });

  return {
    rank: matched ? matched.rank : 0,
    totalAds: ads.length,
    ads,
    matched,
  };
}

module.exports = { getPowerLinkAds, findAdRank, getMobileAdsMore };
