# Novel Collector

Node.js·Playwright 기반 소설 수집기와 웹 대시보드입니다. 최대 두 작업을 실행하고 작품별 회차는 순서대로 처리합니다. 데이터는 로컬 파일 저장소에 보관합니다.

## 주요 기능

- 작품 등록, 예약·일시정지·재개, 실패 회차 재수집
- 파일 기반 작품·회차 저장, TXT/EPUB 및 묶음 다운로드
- 같은 브라우저 세션을 유지하는 사이트 인증과 사용자 CAPTCHA 창
- 서버의 `captcha_required_daily_quota` 응답에만 실행되는 조건부 CAPTCHA 모듈
- 세션별 단일 CAPTCHA 처리, OpenCV 후보 분석, 1.8~4.5초의 실제 브라우저 드래그 기록 검증
- 새 챌린지로 최대 3회 자동 시도 후 기존 수동 CAPTCHA 방식으로 전환

CAPTCHA 자동 제출은 평가된 이미지 점수·후보 차이 임계값을 설정한 경우에만 활성화됩니다. 기본값은 분석 후 제출 보류입니다. 자세한 규약은 [CAPTCHA 문서](docs/CAPTCHA.md)를 확인하세요.

## 실행 환경

Node.js 22 이상, Chromium, Python 3.9 이상이 필요합니다. Linux 서버를 기준으로 개발했습니다.

```sh
npm ci
npx playwright install chromium
uv venv --python python3 .venv-captcha
uv pip install --python .venv-captcha/bin/python -r requirements-captcha.txt
npm start
```

기본 대시보드는 `http://127.0.0.1:8788`입니다. `HOST`, `PORT`, `BROWSER_PATH`, `PROFILE_DIR`로 실행 환경을 지정할 수 있습니다. `deploy/novel-collector.service`는 설치 경로와 전용 사용자를 준비한 뒤 조정할 수 있는 일반 템플릿입니다.

첫 실행에서 관리자 인증 파일이 로컬 `secrets/`에 만들어집니다. 사이트 계정은 설정 화면에서 등록하며 암호화해 저장합니다. 실행 데이터·자격정보·브라우저 프로필은 Git 추적 대상이 아닙니다.

## 구조

| 경로 | 역할 |
|---|---|
| `src/` | HTTP 서버, 스케줄러, 수집기, 저장소, 사이트 인증 |
| `public/` | 대시보드 화면 |
| `tests/` | 단위·통합 테스트와 합성 fixture |
| `tools/` | 이미지 분석·평가 및 Git 공개 대상 검사 |
| `docs/` | 공개용 기능 계약과 검증 문서 |
| `data/`, `profile/`, `secrets/` | 실행 중 생성되는 로컬 전용 데이터 |

## 검증

```sh
npm test
npm run test:captcha
npm run test:captcha:images
node tools/check-publication.mjs
```

전체 테스트에는 기존 소스 전환 관련 실패가 남아 있습니다. 통과 범위와 알려진 실패는 [검증 현황](docs/TESTING.md), 수명·소유권 경계는 [기능 계약](docs/CONTRACT.md)에 기록했습니다.

## 저장소 포함 범위

소스, 합성 테스트, 의존성 명세, 일반 배포 템플릿과 공개 문서만 포함합니다. 수집 본문·DB·비밀번호·계정·쿠키·토큰·브라우저 프로필·실사이트 HTML 캡처·운영 서버 주소·이전 배포 압축본은 포함하지 않습니다. `.gitignore`는 검토한 파일 유형만 허용하는 방식입니다.
