# 설치와 공통 실행기

[README](../README.md) · [대시보드 사용법](DASHBOARD.md) · [문제 해결](TROUBLESHOOTING.md)

## 1. 클린 설치 — 런타임이 없는 환경

릴리스 소스 ZIP을 내려받아 압축을 해제한 뒤 설치 스크립트를 실행합니다. 이 스크립트가 포함된 새 릴리스부터 사용할 수 있으며 이미 게시된 1.0.0.0에는 소급 추가되지 않습니다.

### Windows

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

Node.js가 없거나 지원 버전이 아니면 공식 x64 포터블 패키지를 `.runtime/node`에 준비하고 SHA256을 확인합니다. uv를 통해 Python 3.11을 준비하며 npm 패키지·OpenCV/NumPy·Chromium을 설치합니다. PATH 변경은 이 실행 과정에만 적용하고 전역 Python 패키지나 개인 데이터 폴더를 초기화하지 않습니다.

### Linux

```sh
bash install.sh
bash start.sh
```

공식 Node.js 포터블 바이너리(x64/arm64)와 체크섬, uv/Python, npm, OpenCV/NumPy, Chromium을 준비합니다. Debian/Ubuntu는 Playwright의 install-deps, RHEL 8+/Rocky/AlmaLinux/Fedora는 배포판 라이브러리 패키지를 설치합니다. OS 패키지 설치에는 root 또는 비대화형 sudo 권한이 필요합니다. 수집기는 Chromium sandbox를 사용할 수 있는 일반 사용자/서비스 전용 계정으로 실행하세요. root 설치는 환경 준비이며 root로 브라우저 수집을 실행하는 방식은 아닙니다.

기존 OS 라이브러리가 준비된 개발 환경에서만 `bash install.sh --skip-os-deps`를 사용할 수 있습니다. 최초 설치에는 기본 명령을 사용하세요.

관리자 계정·보관 DB·브라우저 프로필은 각 설치에서 생성하며 설치 스크립트는 이를 삭제하지 않습니다. `.runtime`, `.venv-captcha`, `profile/playwright-browsers`는 로컬 런타임입니다.

## 2. 수동 실행의 준비물

Windows와 Linux 모두 같은 파일을 실행합니다.

- **Node.js 22 이상**과 함께 제공되는 npm
- Python **3.9~3.12**(3.11 권장) 또는 `uv`
- Git 또는 저장소 소스 압축본

Chromium·OpenCV는 실행기가 준비할 수 있습니다. Linux Chromium의 운영체제 공유 라이브러리는 배포판에 맞게 설치해야 합니다. Playwright 지원 Debian/Ubuntu에서는 `npx playwright install --with-deps chromium`을 사용할 수 있고, Rocky/RHEL은 해당 호스트 라이브러리·sandbox를 확인합니다.

```sh
node --version
npm --version
```

Python 설치를 직접 사용할 경우 `python --version` 또는 Linux의 `python3 --version`을 확인합니다. `uv`가 있으면 실행기가 Python 3.11 가상환경을 준비할 수 있습니다. 현재 고정된 NumPy 버전으로 새 가상환경을 준비할 때는 Python 3.9~3.12를 사용합니다.

## 3. 실행 — Windows/Linux 동일

개발 소스는 `develop` 브랜치에 올라갑니다.

```sh
git clone --branch develop https://github.com/organic4597/Novel-collector.git
cd Novel-collector
node run.mjs
```

PowerShell·명령 프롬프트·Linux 터미널 모두 마지막 명령이 같습니다. 프로그램 폴더가 아닌 위치에서는 파일의 전체 경로를 따옴표로 감싸 실행할 수 있습니다.

```powershell
node "C:\Novel Collector\run.mjs"
```

```sh
node "/opt/novel collector/run.mjs"
```

프로젝트 폴더를 자동으로 작업 경로로 사용합니다. 브라우저 프로필·DB·인증은 그 설치의 로컬 폴더에 저장합니다.

### 실행기가 하는 일

1. Node 버전과 npm 런타임 패키지 확인. 없거나 버전이 다르면 `npm ci --omit=dev`로 준비.
2. 독립 `.venv-captcha`의 Python/OpenCV/NumPy 확인. 없으면 uv 또는 Python venv/pip로 준비.
3. 현재 `BROWSER_PATH`, 로컬 브라우저 또는 Playwright Chromium 확인. 없으면 다운로드.
4. 현재 세션·데이터 경로를 사용해 서버 실행.

준비된 환경은 매번 다시 설치하지 않습니다. Windows npm은 `npm.cmd` 셸 실행 대신 Node의 JavaScript CLI로 호출하여 공백 경로와 인자 전달을 처리합니다. Python 경로도 Windows는 `.venv-captcha/Scripts/python.exe`, Linux는 `.venv-captcha/bin/python`으로 구분합니다.

## 4. 옵션

| 명령 | 동작 |
|---|---|
| `node run.mjs` | 필요 환경 준비 후 실행 |
| `node run.mjs --setup` | 준비만 수행하고 종료 |
| `node run.mjs --check` | 설치·서버 시작 없이 환경 확인 |
| `node run.mjs --no-setup` | 자동 설치 없이 준비된 서버 실행 |
| `node run.mjs --test-images` | 준비된 Python 환경의 이미지 테스트 |
| `node run.mjs --help` | 옵션 표시 |

`npm start`, `npm run setup`, `npm run check`도 같은 실행기를 사용합니다. `--check`와 `--no-setup`에서 의존성이 빠져 있으면 설치하지 않고 오류를 안내합니다.

## 5. 첫 접속과 환경 변수

기본 주소는 `http://127.0.0.1:8788`입니다. 첫 실행에서 생성한 `secrets/admin-login.txt`의 초기 관리자 비밀번호로 접속합니다. 변경 뒤에는 해시가 보관되고 초기 파일은 제거됩니다. 사이트 계정·PIN은 대시보드에서 등록합니다.

| 변수 | 기본 / 용도 |
|---|---|
| `HOST`, `PORT` | loopback / 8788 |
| `PROFILE_DIR` | `profile/chromium`. 기존 `data/browser-profile`이 있으면 재사용하며 명시한 경로가 우선 |
| `BROWSER_PATH` | 지정한 Chromium을 우선 사용 |
| `PLAYWRIGHT_BROWSERS_PATH` | 기본 `profile/playwright-browsers` |
| `CAPTCHA_PYTHON` | OS별 독립 가상환경 경로 |
| `CAPTCHA_MIN_SCORE`, `CAPTCHA_MIN_MARGIN` | 평가한 이미지 임계값 |
| `TRUST_PROXY`, `SECURE_COOKIES` | 자체 HTTPS 대시보드 앞단 설정 |
| `UPDATE_REPOSITORY` | `organic4597/Novel-collector`. GitHub owner/repository 또는 저장소 URL |

명시적인 `CAPTCHA_PYTHON`을 지정하면 해당 Python 환경을 확인하며 자동으로 패키지를 설치하지 않습니다. 평가 임계값을 생략하면 이미지 분석 결과 제출은 보류합니다. 계정·쿠키·토큰·실제 운영 주소는 Git에 포함하지 않습니다.

## 6. Linux 서비스와 대시보드 업데이트

템플릿은 `deploy/novel-collector.service`이며 `/opt/novel-collector`, 사용자 `novelcollector`를 기준으로 합니다. 실행기는 같고 서비스는 `--no-setup`을 사용합니다.

```ini
[Service]
WorkingDirectory=/opt/novel-collector
ExecStart=/bin/bash /opt/novel-collector/start.sh --no-setup
Environment=UPDATE_WORKER_SURVIVES_SERVICE=1
Environment=UPDATE_SERVICE_NAME=novel-collector.service
KillMode=process
ReadWritePaths=/opt/novel-collector
```

전용 사용자와 읽기/실행 권한, `data/`, `profile/`, `secrets/`의 쓰기 권한을 준비합니다. 서비스 등록 전에 해당 환경에서 `node run.mjs --setup`과 `--check`를 완료하세요. 읽기 전용 서비스 제한 안에서는 npm·Python 설치를 수행하지 않습니다.

```sh
sudo install -m 644 deploy/novel-collector.service /etc/systemd/system/novel-collector.service
sudo systemctl daemon-reload
sudo systemctl enable --now novel-collector.service
sudo systemctl status novel-collector.service
```

이미 서비스가 있으면 ExecStart를 위 실행기로 연결하는 drop-in 설정을 추가할 수 있습니다. 기존 포트·프로필·계정 경로·HTTPS 설정은 그대로 사용합니다.

대시보드 업데이트를 사용하려면 설치 폴더를 서비스 전용 사용자 소유로 두고 위 설정을 함께 적용합니다. 정상 종료 후 업데이트 worker가 남아 작업을 끝내도록 KillMode=process를 사용합니다. 소스 폴더가 읽기 전용인 기존 서비스는 자동 업데이트를 실행하지 않고 권한/설정 오류를 안내합니다.

## 7. 검증

```sh
node run.mjs --check
node run.mjs --test-images
```

개발 테스트까지 실행하려면 개발 의존성을 포함해 `npm ci`를 수행한 뒤 `npm test`를 실행합니다. 실행기의 기본 자동 설치는 런타임 패키지만 설치합니다. 브라우저 테스트에는 해당 환경의 Chromium을 `BROWSER_PATH`로 지정할 수 있습니다.

서비스 연결 후 대시보드에서 실제 본문 저장과 다음 회차 진행을 확인합니다. 기존 전체 테스트 실패 항목은 [검증 현황](TESTING.md)에 공개되어 있습니다.
