# 네이버 SA 솔루션

네이버 검색광고(SA) API 기반 **자동 리포트 + 방문자 로그 분석** 통합 솔루션

---

## 📁 프로젝트 구조

```
naver-sa-solution/
├── src/
│   ├── index.js              # 메인 진입점
│   ├── api/
│   │   └── naverApi.js       # 네이버 SA API 클라이언트 (HMAC 인증)
│   ├── report/
│   │   └── generator.js      # 리포트 데이터 수집 & 이메일 발송
│   ├── email/
│   │   └── sender.js         # HTML 이메일 템플릿 & Nodemailer
│   ├── scheduler/
│   │   ├── index.js          # Cron 스케줄러 (일/주/월)
│   │   ├── autoBid.js        # 자동입찰 모듈
│   │   └── run.js            # 수동 실행 CLI
│   └── tracker/
│       ├── server.js         # Express 라우터 (추적 엔드포인트 + 대시보드)
│       ├── parser.js         # 유입소스/키워드/기기 파싱
│       └── db.js             # SQLite 저장 & 통계 쿼리
├── public/
│   └── tracker.js            # 웹사이트에 삽입할 클라이언트 스크립트
├── config/
│   └── index.js              # 설정 & 기능 플래그
├── data/                     # SQLite DB 파일 (자동 생성)
├── .env.example              # 환경변수 예시
└── package.json
```

---

## ⚡ 빠른 시작

### 1. 설치

```bash
npm install
cp .env.example .env
```

### 2. .env 설정

```env
# 네이버 검색광고 API (searchad.naver.com → 도구 → API 사용관리)
NAVER_API_KEY=your_access_license
NAVER_SECRET_KEY=your_secret_key
NAVER_CUSTOMER_ID=your_customer_id

# Gmail (앱 비밀번호: Google 계정 → 2단계 인증 → 앱 비밀번호)
EMAIL_USER=your@gmail.com
EMAIL_PASS=xxxx_xxxx_xxxx_xxxx
EMAIL_TO=report@yourcompany.com

# 로그분석 서버 (외부 접근 가능한 도메인/IP 입력)
SITE_DOMAIN=https://yourdomain.com
TRACKER_SECRET=my-secret-token-2024
```

### 3. 실행

```bash
# 서버 + 스케줄러 동시 시작
npm start

# 리포트 즉시 테스트
npm run report:daily
npm run report:weekly
npm run report:monthly
```

---

## 🔀 기능 ON/OFF 제어

`.env` 파일에서 각 기능을 독립적으로 켜고 끌 수 있습니다.

| 환경변수 | 기본값 | 설명 |
|---|---|---|
| `FEATURE_DAILY_REPORT` | `true` | 일간 리포트 (매일 08:00) |
| `FEATURE_WEEKLY_REPORT` | `true` | 주간 리포트 (월요일 09:00) |
| `FEATURE_MONTHLY_REPORT` | `true` | 월간 리포트 (매월 1일 09:00) |
| `FEATURE_KEYWORD_TRACKER` | `true` | 방문자 로그 분석 서버 |
| `FEATURE_AUTO_BIDDING` | **`false`** | 자동입찰 (기본 OFF) |

---

## 📊 기능 1: 자동 리포트 이메일

매일/매주/매월 성과 데이터를 이메일로 자동 발송합니다.

**포함 내용:**
- 총 노출수, 클릭수, 전환매출, CTR (전일 대비 추세 포함)
- 평균 노출 순위
- 키워드별 성과 Top 10 테이블

**수동 실행:**
```bash
node src/scheduler/run.js daily
```

---

## 🔑 기능 2: 방문자 로그 분석

### 스크립트 삽입 (웹사이트)

모든 페이지 `</body>` 직전에 추가:

```html
<script src="https://yourdomain.com/tracker.js"></script>
```

### 전환 추적 (구매완료 페이지)

```html
<script>
  // 구매 완료 시
  NaverTracker.conversion('purchase', 39000); // 이벤트, 금액(원)

  // 회원가입 완료 시
  NaverTracker.conversion('signup', 0);
</script>
```

### 대시보드 접속

```
http://yourdomain.com/tracker/dashboard?token=your-secret-token
```

**대시보드 제공 정보:**
- 유입 소스별 방문수 (네이버SA / 네이버자연검색 / 구글 / 다이렉트 등)
- 유입 키워드 Top 20
- 방문자 IP Top 20 (이상 트래픽 자동 감지)
- 일별 방문 추이

---

## 🤖 기능 3: 자동입찰

`FEATURE_AUTO_BIDDING=true` 로 활성화

```env
AUTO_BID_TARGET_RANK=3     # 목표 순위
AUTO_BID_MAX_BID=5000      # 최대 입찰가 (원)
AUTO_BID_MIN_BID=100       # 최소 입찰가 (원)
AUTO_BID_INTERVAL_MINUTES=5  # 실행 간격 (분)
```

**동작 방식:**
- 현재 순위 < 목표 순위: 입찰가 10% 인상 (maxBid 초과 안 함)
- 현재 순위 > 목표 순위 + 1: 입찰가 8% 인하 (minBid 미만 안 함)

⚠️ **주의**: 자동입찰은 기본 OFF입니다. 테스트 후 신중히 활성화하세요.

---

## 🔍 유입 소스 분류 기준

| 소스 코드 | 분류 기준 |
|---|---|
| `naver_sa` | URL에 `n_keyword_id` 또는 `NaPm` 파라미터 존재 |
| `naver_organic` | Referrer가 `search.naver.com` |
| `google_organic` | Referrer가 `google.com` |
| `google_ads` | UTM 파라미터: `utm_source=google&utm_medium=cpc` |
| `daum` | Referrer가 `daum.net` 또는 `kakao.com` |
| `direct` | Referrer 없음 |
| `referral` | 기타 외부 사이트에서 유입 |

---

## 📌 Gmail 앱 비밀번호 발급 방법

1. Google 계정 → 보안 → 2단계 인증 활성화
2. 2단계 인증 → 앱 비밀번호 → 앱: "메일", 기기: "기타" 선택
3. 생성된 16자리 비밀번호를 `EMAIL_PASS`에 입력

---

## 💡 API 호출 최적화 팁

- 리포트는 하루 1~3회만 실행 → 호출 부담 최소화
- 자동입찰은 5분 이상 간격 권장 (1분 간격은 Rate Limit 위험)
- 불필요한 기능은 `FEATURE_*=false`로 즉시 차단
- Rate Limit(429) 발생 시 지수 백오프 자동 재시도 로직 내장
