const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/tracker.db');

let db = null;

function getDb() {
  if (!db) {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) throw new Error('DB 연결 실패: ' + err.message);
    });
    db.run('PRAGMA journal_mode = WAL');
  }
  return db;
}

/**
 * 테이블 초기화
 */
function initDb() {
  const database = getDb();

  database.serialize(() => {
    // 방문자 로그 테이블
    database.run(`
      CREATE TABLE IF NOT EXISTS visits (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at   TEXT    DEFAULT (datetime('now', 'localtime')),
        ip           TEXT,
        user_agent   TEXT,
        page_url     TEXT,
        referrer     TEXT,
        source       TEXT,    -- naver_sa / naver_organic / google / direct / etc
        keyword      TEXT,    -- 검색 키워드 (광고 파라미터 또는 referrer에서 추출)
        campaign_id  TEXT,    -- n_campaign_id
        ad_group_id  TEXT,    -- n_adgroup_id
        keyword_id   TEXT,    -- n_keyword_id
        device       TEXT,    -- mobile / desktop / tablet
        country      TEXT,
        city         TEXT,
        session_id   TEXT
      )
    `);

    // 전환 이벤트 테이블
    database.run(`
      CREATE TABLE IF NOT EXISTS conversions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at  TEXT    DEFAULT (datetime('now', 'localtime')),
        session_id  TEXT,
        ip          TEXT,
        event_type  TEXT,   -- purchase / signup / contact / etc
        value       REAL,   -- 전환 금액
        keyword     TEXT,
        source      TEXT
      )
    `);

    // 인덱스
    database.run(`CREATE INDEX IF NOT EXISTS idx_visits_created ON visits(created_at)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_visits_keyword ON visits(keyword)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_visits_source  ON visits(source)`);
    database.run(`CREATE INDEX IF NOT EXISTS idx_visits_ip      ON visits(ip)`);
  });

  console.log('✅ DB 초기화 완료:', DB_PATH);
  return database;
}

/**
 * 방문 기록 저장
 */
function insertVisit(data) {
  return new Promise((resolve, reject) => {
    getDb().run(
      `INSERT INTO visits (ip, user_agent, page_url, referrer, source, keyword, campaign_id, ad_group_id, keyword_id, device, country, city, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.ip, data.userAgent, data.pageUrl, data.referrer, data.source,
       data.keyword, data.campaignId, data.adGroupId, data.keywordId,
       data.device, data.country, data.city, data.sessionId],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * 전환 기록 저장
 */
function insertConversion(data) {
  return new Promise((resolve, reject) => {
    getDb().run(
      `INSERT INTO conversions (session_id, ip, event_type, value, keyword, source)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [data.sessionId, data.ip, data.eventType, data.value, data.keyword, data.source],
      function(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * 통계 쿼리 - 대시보드용
 */
function queryStats(days = 7) {
  return new Promise((resolve, reject) => {
    const queries = {};

    // 소스별 방문 수
    getDb().all(
      `SELECT source, COUNT(*) as cnt FROM visits
       WHERE created_at >= datetime('now', '-${days} days', 'localtime')
       GROUP BY source ORDER BY cnt DESC`,
      (err, rows) => {
        if (err) return reject(err);
        queries.bySource = rows;

        // 키워드별 방문 수 (Top 20)
        getDb().all(
          `SELECT keyword, source, COUNT(*) as cnt FROM visits
           WHERE keyword IS NOT NULL AND keyword != ''
             AND created_at >= datetime('now', '-${days} days', 'localtime')
           GROUP BY keyword ORDER BY cnt DESC LIMIT 20`,
          (err2, rows2) => {
            if (err2) return reject(err2);
            queries.topKeywords = rows2;

            // IP별 방문 수 (Top 20 - 이상 트래픽 감지용)
            getDb().all(
              `SELECT ip, COUNT(*) as cnt, MAX(created_at) as last_seen FROM visits
               WHERE created_at >= datetime('now', '-${days} days', 'localtime')
               GROUP BY ip ORDER BY cnt DESC LIMIT 20`,
              (err3, rows3) => {
                if (err3) return reject(err3);
                queries.topIps = rows3;

                // 일별 방문 추이
                getDb().all(
                  `SELECT date(created_at) as day, COUNT(*) as cnt FROM visits
                   WHERE created_at >= datetime('now', '-${days} days', 'localtime')
                   GROUP BY day ORDER BY day`,
                  (err4, rows4) => {
                    if (err4) return reject(err4);
                    queries.dailyTrend = rows4;
                    resolve(queries);
                  }
                );
              }
            );
          }
        );
      }
    );
  });
}

module.exports = { initDb, insertVisit, insertConversion, queryStats, getDb };
