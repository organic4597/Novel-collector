# 설치 매뉴얼

[README](../README.md) · [대시보드 사용법](DASHBOARD.md) · [문제 해결](TROUBLESHOOTING.md)

## 1. 준비물

- Node.js **22 이상**, npm, Git
- Python **3.9 이상**, `uv` 또는 Python venv/pip
- 실행 가능한 Chromium과 해당 운영체제의 공유 라이브러리
- Linux 서비스 환경에서는 전용 사용자와 쓰기 가능한 로컬 디스크

```sh
node --version
npm --version
python3 --version
git --version
```

저장 본문·브라우저 프로필이 커질 수 있으므로 저장 디스크의 여유 공간을 확인합니다.

## 2. 소스와 의존성

```sh
git clone https://github.com/organic4597/Novel-collector.git
cd Novel-collector
npm ci
npx playwright install chromium
uv venv --python python3 .venv-captcha
uv pip install --python .venv-captcha/bin/python -r requirements-captcha.txt
```

`uv`를 사용하지 않는 환경에서는 아래 Python 경로로 준비할 수 있습니다.

```sh
python3 -m venv .venv-captcha
.venv-captcha/bin/python -m pip install -r requirements-captcha.txt
```

Chromium의 Linux 의존성은 운영체제마다 다릅니다. Playwright가 지원하는 Debian/Ubuntu 환경에서는 `npx playwright install --with-deps chromium`을 사용할 수 있습니다. Rocky/RHEL 계열에서는 호스트 라이브러리와 Chromium sandbox 동작을 따로 확인하고 필요하면 `BROWSER_PATH`에 실제 실행 파일을 지정합니다. 이 프로젝트가 특정 배포판의 의존성을 자동 설치하지는 않습니다.

## 3. 첫 실행

```sh
npm start
```

기본 주소는 `http://127.0.0.1:8788`입니다. 첫 실행 후 로컬 `secrets/admin-login.txt`에 생성된 초기 관리자 비밀번호로 로그인합니다. 비밀번호 변경 후 초기 파일은 제거되며 인증 정보는 `admin-credentials.json`에 해시로 보관됩니다. 파일 내용을 Git에 올리거나 로그에 출력하지 않습니다.

대시보드의 설정에서 사이트 주소, 자동 로그인 계정과 PIN을 등록합니다. 계정은 해당 사이트의 로컬 암호화 저장소에 저장됩니다. 저장소에서 다른 설치의 계정·쿠키·프로필을 내려받을 수는 없습니다.

## 4. 주요 환경 변수

| 변수 | 기본 / 용도 |
|---|---|
| `HOST` | `127.0.0.1`, 앱 바인딩 주소 |
| `PORT` | `8788`, 앱 포트 |
| `BROWSER_PATH` | 생략하면 Playwright 설치 Chromium 사용 |
| `PROFILE_DIR` | 로컬 브라우저 프로필 위치. 슬롯 1·2는 하위 폴더 사용 |
| `CAPTCHA_PYTHON` | 기본 `.venv-captcha/bin/python` |
| `CAPTCHA_MIN_SCORE` | 분석 점수 임계값, 0 초과 1 이하 |
| `CAPTCHA_MIN_MARGIN` | 독립 후보 점수 차이 임계값, 0 초과 1 이하 |
| `TRUST_PROXY` | loopback 앞단 HTTP 프록시를 신뢰할 때만 `1` |
| `SECURE_COOKIES` | HTTPS 접속 환경의 쿠키 설정 |

사이트 수집은 직접 연결합니다. VPN·수집 프록시 전환 코드와 환경값은 없습니다. `TRUST_PROXY`는 대시보드 앞단 HTTP 서버의 접속 출처 처리용이며 수집 네트워크 프록시가 아닙니다.

CAPTCHA의 두 이미지 임계값을 생략하면 분석하되 자동 제출은 보류합니다. 합성 테스트에서 사용하는 `0.85`/`0.12`는 시험용 프로필입니다. 실제 이미지 평가 후 설치 환경에 맞는 값을 선택하세요. 자동 시도는 최대 **5회**, 실패하면 기존 수동 확인으로 전환합니다.

## 5. systemd 서비스

일반 템플릿은 `deploy/novel-collector.service`입니다. 기본 설치 경로는 `/opt/novel-collector`, 전용 사용자는 `novelcollector`로 되어 있습니다. 실제 설치 경로와 Chromium 위치에 맞춰 조정합니다.

관리자 권한으로 전용 사용자를 준비하고, 프로젝트를 배치한 뒤 `data/`, `profile/`, `secrets/`를 해당 사용자가 쓸 수 있게 합니다. `node_modules`, Python 환경, Chromium도 서비스 사용자에게 읽기·실행 권한이 필요합니다. 서비스 사용자로 브라우저를 설치했다면 같은 사용자의 Playwright cache를 사용합니다.

```sh
sudo install -m 644 deploy/novel-collector.service /etc/systemd/system/novel-collector.service
sudo systemctl daemon-reload
sudo systemctl enable --now novel-collector.service
sudo systemctl status novel-collector.service
```

환경 변경은 systemd override에서 관리합니다.

```ini
[Service]
Environment=HOST=127.0.0.1
Environment=PORT=8788
Environment=BROWSER_PATH=/path/to/chromium
Environment=CAPTCHA_PYTHON=/opt/novel-collector/.venv-captcha/bin/python
# 평가한 값이 있을 때만 설정:
# Environment=CAPTCHA_MIN_SCORE=0.85
# Environment=CAPTCHA_MIN_MARGIN=0.12
```

설정 후 `systemctl daemon-reload`와 서비스 재시작이 필요합니다. 진행 중 작업은 저장 회차와 검증 목차를 재사용합니다. 외부 접속이 필요하면 앱의 loopback 바인딩 앞에 자체 HTTPS 서버를 구성합니다. 개인 도메인·IP·인증 파일은 공개 저장소에 넣지 않습니다.

## 6. 설치 확인

```sh
npm run test:captcha
npm run test:captcha:images
curl http://127.0.0.1:8788/api/session
```

마지막 응답은 로그인 전 `{ "authenticated": false }`입니다. 대시보드에서 한 작품의 짧은 범위를 등록해 본문 저장·TXT·다음 회차 진행을 확인합니다. 전체 테스트의 기존 실패 항목은 [검증 현황](TESTING.md)에 공개되어 있습니다.
