# 처음 설치부터 관리자 로그인까지

[README](../README.md) · [로그인 후 이용 매뉴얼](DASHBOARD.md) · [문제 해결](TROUBLESHOOTING.md)

**처음 사용하는 사람을 위한 정식 설치 안내입니다.** Windows는 x64, 서버 예시는 Rocky/Linux x64를 기준으로 설명합니다. 설치 스크립트는 Windows와 Linux를 지원합니다. Linux arm64용 Node 준비 경로도 있지만 Chromium과 해당 배포판의 실제 실행 지원은 별도로 확인해야 합니다.

## 설치 방식 선택

| 사용할 환경                                  | 따라갈 부분                                       |
| -------------------------------------------- | ------------------------------------------------- |
| Windows PC에서 직접 실행                     | [Windows 설치](#windows-설치)                     |
| 일반 Linux 계정에서 터미널 실행              | [일반 Linux 사용자 설치](#일반-linux-사용자-설치) |
| root로 접속한 Rocky 서버·재부팅 후 자동 시작 | [Rocky/Linux 서버 설치](#rockylinux-서버-설치)    |
| 다른 PC·휴대전화·HTTPS 주소로 접속           | [접속 주소](#다른-pc와-모바일에서-접속)           |
| 설치는 끝났고 비밀번호를 찾는 중             | [첫 관리자 로그인](#첫-관리자-로그인)             |
| 관리자 비밀번호 분실                         | [복구](#관리자-비밀번호를-잊었을-때)              |

## 설치 파일 받기

1. [GitHub 최신 정식 릴리스](https://github.com/organic4597/Novel-collector/releases/latest)를 엽니다.
2. **Assets**의 `Novel-collector-<버전>.zip`을 받습니다. Linux에서는 `Novel-collector-<버전>.tar.gz`도 사용할 수 있습니다.
3. 압축을 풉니다. 압축 안쪽에서 다음 파일이 함께 있는 폴더를 찾습니다.

   ```text
   install.ps1   install.sh
   start.ps1     start.sh
   run.mjs       package.json   package-lock.json
   src/          public/        tools/        docs/
   ```

4. 이 폴더를 **설치 폴더**로 사용합니다. ZIP 이름과 같은 바깥 폴더가 한 번 더 생겼다면 안쪽 폴더까지 들어갑니다. 압축 안에서 바로 실행하지 않습니다.

GitHub 자동 생성 **Source code** 압축은 개발 소스용입니다. 이 안내는 릴리스 첨부 ZIP/TAR 기준이며 내장 업데이터도 릴리스 첨부 ZIP과 체크섬을 사용합니다. 첨부 `Novel-collector-<버전>-SHA256SUMS.txt`는 내려받은 파일의 SHA256을 확인할 때 사용합니다.

설치와 첫 환경 준비에는 인터넷 연결이 필요합니다. 설치 폴더와 다운로드하는 런타임·저장할 작품을 위한 디스크 여유를 확보하세요.

## Windows 설치

### 1. 설치 폴더에서 PowerShell 열기

설치 폴더는 현재 Windows 계정이 쓰기 가능한 위치에 둡니다. 아래 `C:\Novel-collector`는 예시이며 실제 압축을 푼 위치로 바꿉니다.

```powershell
Set-Location "C:\Novel-collector"
Test-Path .\run.mjs
```

두 번째 명령 결과가 `True`인지 확인합니다. `False`이면 폴더 위치가 잘못된 것입니다.

### 2. 실행 환경 설치

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

지원되는 Node.js 22 이상이 없으면 공식 x64 포터블 Node 패키지를 `.runtime\node`에 준비하고 체크섬을 확인합니다. 설치기는 uv/Python 환경, npm 패키지와 Chromium 등 필요한 의존성을 준비합니다. PATH는 설치/실행 과정에 적용하며 전역 Python 패키지를 바꾸는 방식이 아닙니다.

설치와 이후 실행에는 같은 Windows 계정을 사용합니다. 오류가 나면 [설치 문제 해결](TROUBLESHOOTING.md#설치가-끝나지-않거나-실행되지-않음)을 확인하세요.

### 3. 실행

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

실행 창의 `Novel Collector 실행 중`과 주소를 확인합니다. 브라우저에서 `http://127.0.0.1:8788`을 열고 [첫 관리자 로그인](#첫-관리자-로그인)을 진행합니다. 다른 포트를 설정했다면 실행 창에 표시된 주소를 사용합니다.

터미널로 실행한 프로그램은 그 실행 창이 닫히거나 Windows가 종료되면 계속 수집할 수 없습니다. 다시 사용할 때는 `start.ps1`을 실행합니다. Windows 자동 시작 서비스 설치는 이 스크립트가 수행하는 기능이 아닙니다.

### 환경 점검만 하기

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1 --check
```

점검 모드는 서버를 시작하거나 빠진 패키지를 설치하지 않습니다. 포터블 Node를 사용한 설치에서도 PATH를 구성하는 시작 스크립트를 통해 점검할 수 있습니다.

## 일반 Linux 사용자 설치

**일반 사용자로 로그인하고 sudo를 사용할 수 있는 경우**입니다. 압축을 푼 설치 폴더에서 실행합니다.

```sh
sudo bash install.sh --service-user "$(id -un)"
bash start.sh
```

설치는 root 권한으로 필요한 OS 패키지를 준비하고, 실행과 개인 자료는 지정한 일반 계정으로 사용하도록 권한을 맞춥니다. 프로그램은 일반 계정의 `bash start.sh`에서 실행합니다. 터미널 실행은 해당 실행 프로세스가 계속 살아 있어야 수집이 진행됩니다. 서버 자동 시작은 다음 서비스 설치를 사용하세요.

Node.js 22 이상이 없으면 공식 Node 포터블 패키지를 준비합니다. 설치기는 uv/Python, npm 패키지, Chromium과 OS 공유 라이브러리를 준비합니다. Debian/Ubuntu는 Playwright의 의존성 설치, Rocky/RHEL 계열은 `dnf` 패키지 설치를 사용합니다.

이미 OS 공유 라이브러리가 준비된 환경에서만 `--skip-os-deps`를 사용할 수 있습니다. 처음 설치에서는 생략하지 않습니다.

```sh
bash start.sh --check
```

이 점검이 통과한 뒤 브라우저에서 [첫 관리자 로그인](#첫-관리자-로그인)을 진행합니다.

## Rocky/Linux 서버 설치

root 또는 sudo 관리 권한을 사용할 수 있는 서버의 **첫 설치 예시**입니다. 경로 `/opt/novel-collector`, 계정·그룹 `novelcollector`, 서비스 `novel-collector.service`는 제공 템플릿과 같은 일반 예시입니다. 실제 경로를 바꾸면 서비스 설정도 함께 바꿉니다.

### 1. 실행 계정과 설치 폴더 준비

```sh
id novelcollector >/dev/null 2>&1 || sudo useradd --system --user-group --create-home --home-dir /var/lib/novelcollector --shell /usr/sbin/nologin novelcollector
sudo mkdir -p /opt/novel-collector
```

다운로드한 릴리스 압축을 풀고 **`install.sh`와 `run.mjs`가 있는 안쪽 폴더의 내용**을 `/opt/novel-collector`에 배치합니다. SSH 파일 전송 도구나 서버 파일 관리자를 사용할 수 있습니다.

```sh
cd /opt/novel-collector
test -f install.sh && test -f run.mjs && test -f package-lock.json
```

마지막 명령이 성공해야 다음 단계로 진행합니다. 이 계정은 서비스용이므로 대화형 로그인을 할 필요가 없습니다.

### 2. 실행 환경과 권한 설치

```sh
sudo bash install.sh --service-user novelcollector
sudo -u novelcollector bash start.sh --check
```

처음 root로 설치할 때는 실행 계정을 먼저 준비하고 `--service-user`로 지정합니다. **설치 준비는 root, 브라우저 수집 실행은 일반/서비스 계정**입니다. 단순히 root에서 `bash install.sh`만 실행하는 안내와 구분하세요.

설치기는 소스·런타임의 서비스 그룹 권한과 `data`, `secrets`, `profile`, `.updates`의 실행 계정 접근 권한을 준비하고, 실제 계정으로 백업·교체 권한을 점검합니다. 기존 사용자 자료와 `.git`, 외부 심볼릭 링크 대상을 초기화하지 않습니다.

### 3. 서비스 설정 확인

`deploy/novel-collector.service`를 열어 다음 항목이 실제 설치와 맞는지 확인합니다.

| 항목           | 제공 템플릿의 값                                                                                      |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| 실행 계정·그룹 | `User=novelcollector`, `Group=novelcollector`                                                         |
| 설치 폴더      | `WorkingDirectory=/opt/novel-collector`                                                               |
| 실행           | `ExecStart=/bin/bash /opt/novel-collector/start.sh --no-setup`                                        |
| 접속           | `HOST=127.0.0.1`, `PORT=8788`                                                                         |
| 프로필·캐시    | 설치 폴더의 `profile/`                                                                                |
| 쓰기 허용      | `ReadWritePaths=/opt/novel-collector`                                                                 |
| 업데이트       | `KillMode=process`, `UPDATE_WORKER_SURVIVES_SERVICE=1`, `UPDATE_SERVICE_NAME=novel-collector.service` |

설치 경로를 바꾸면 `WorkingDirectory`, `ExecStart`, 프로필·캐시 경로와 `ReadWritePaths`를 모두 맞춥니다. 서비스 이름을 바꾸면 `UPDATE_SERVICE_NAME`도 맞춥니다. 포트가 사용 중이면 `PORT`를 다른 번호로 바꿉니다.

개발 인스턴스의 소유자 메뉴가 필요한 경우에만 저장소 밖의 비공개 서비스 환경 파일에 `NC_RUNTIME_MODE=development`와 `OWNER_HUB_URL=https://hub.example.test/`를 설정합니다. 실제 개인 주소를 공개 소스나 배포 압축 파일에 넣지 마세요. 기본값과 릴리스 모드는 주소 설정이 있더라도 소유자 메뉴를 제공하지 않습니다. 목적지는 계정 정보·쿼리·조각 식별자가 없는 HTTPS 주소만 허용하며 로그인한 관리자에게만 전달합니다.

운영 데이터를 복제한 개발 인스턴스를 처음 확인할 때는 `NC_BACKGROUND_WORK=0`으로 자동 수집·브라우저 정기 갱신·업데이트 확인을 시작하지 않을 수 있습니다. 이 옵션은 명시적인 개발 모드에서만 적용되며, 저장된 작업이나 운영 인스턴스 상태를 변경하지 않습니다. 수집을 검증하려면 운영 환경과 작업이 겹치지 않음을 확인한 후 설정을 제거하고 개발 인스턴스를 다시 시작합니다.

### 4. 등록과 자동 시작

```sh
sudo install -m 644 deploy/novel-collector.service /etc/systemd/system/novel-collector.service
sudo systemctl daemon-reload
sudo systemctl enable --now novel-collector.service
sudo systemctl status novel-collector.service --no-pager
```

`active (running)`인지 확인합니다. 실패 원인은 다음으로 확인합니다.

```sh
sudo journalctl -u novel-collector.service -n 50 --no-pager
```

이제 SSH를 닫아도 서비스가 살아 있는 동안 수집이 진행되고, 서버 재부팅 시 다시 시작합니다. 처음 실행한 뒤 초기 관리자 비밀번호를 확인하세요.

기존 같은 이름의 서비스를 재설치하는 명령으로 사용하지 마세요. 기존 설치는 먼저 정상 종료하고 [업데이트 절차](UPDATE.md)를 확인합니다.

## 첫 관리자 로그인

1. **설치한 컴퓨터/서버**에서 프로그램이 실제로 실행 중인지 확인합니다. 설치만 하고 실행하지 않았다면 초기 비밀번호 파일이 아직 없을 수 있습니다.
2. 설치 폴더의 `secrets/admin-login.txt`를 확인합니다. 서버에서는 SSH/파일 관리자로 확인하고, Windows에서는 메모장 등으로 엽니다.
3. 해당 파일의 비밀번호로 대시보드의 **관리자 비밀번호**에 로그인합니다. 이 화면에는 원본 사이트 아이디나 PIN을 입력하지 않습니다.
4. 로그인 후 **관리 → 설정 → 보안**에서 현재 비밀번호와 새 비밀번호를 입력하고 **비밀번호 변경**을 누릅니다. 새 비밀번호는 8~128자입니다.
5. 변경하면 초기 `admin-login.txt`는 삭제되고 다른 기기의 기존 로그인은 해제됩니다. 새 비밀번호를 별도로 보관하세요.

관리자 로그인 쿠키의 유효시간은 6시간입니다. 로그인 화면으로 돌아오면 관리자 비밀번호로 다시 로그인합니다. 사이트 로그인과 추가 인증은 별개이며 [이용 매뉴얼](DASHBOARD.md#사이트-계정-설정)에서 이어서 설정합니다.

초기 파일은 평문 비밀번호를 포함하므로 GitHub·공개 이슈·공유 폴더에 올리지 않습니다. 설치 폴더의 `secrets`를 사용자끼리 공유하는 방식으로 로그인하지 않습니다.

## 다른 PC와 모바일에서 접속

### 같은 PC에서 사용

기본 `HOST=127.0.0.1`, `PORT=8788`이면 **프로그램을 실행한 컴퓨터**에서 `http://127.0.0.1:8788`을 엽니다. 다른 PC·휴대전화의 `127.0.0.1`은 그 기기 자신을 가리키므로 서버에 연결되지 않습니다.

### 같은 네트워크에서 사용

LAN으로 직접 열 때는 서버가 외부 인터페이스를 수신하도록 `HOST`를 설정하고 사용 중인 포트에 대한 방화벽 접근을 허용합니다. 주소는 `http://서버의-LAN-IP:포트`입니다. `0.0.0.0`은 수신 설정값이며 브라우저에 입력하는 주소가 아닙니다.

Windows 터미널 실행 예시:

```powershell
$env:HOST = "0.0.0.0"
$env:PORT = "8788"
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

일반 Linux 계정의 터미널 실행 예시:

```sh
HOST=0.0.0.0 PORT=8788 bash start.sh
```

systemd 서비스는 등록된 서비스 파일 또는 drop-in의 `Environment=HOST`, `Environment=PORT`를 수정한 뒤 `daemon-reload`와 해당 서비스 재시작으로 반영합니다. Windows 방화벽과 Rocky의 firewalld 설정은 해당 서버의 허용 범위에 맞춰 관리하세요.

### HTTPS·역방향 프록시·Cloudflare Tunnel

같은 서버의 프록시/터널 앞단을 사용할 때 앱은 기본 loopback 수신을 유지할 수 있습니다. 터널의 서비스 URL은 **`http://127.0.0.1:8788`**이며 실제 `PORT`가 다르면 그 포트를 사용합니다. 전체 대시보드를 연결할 때 경로 조건은 비워 둡니다. 사용자는 터널에 등록한 HTTPS 호스트 이름으로 접속합니다.

공개 호스트 등록, 터널 생성과 프록시 자체 설치는 Novel Collector 설치기가 수행하지 않습니다. HTTPS 프록시 뒤에서 전달된 프로토콜과 Secure 쿠키를 사용하려면 실행 환경에 다음을 지정합니다.

```ini
[Service]
Environment=TRUST_PROXY=1
Environment=SECURE_COOKIES=1
```

이 설정은 신뢰하는 프록시만 앱에 접근하는 구성과 HTTPS 접속을 전제로 합니다. 직접 HTTP만 사용하는 첫 로컬 설치에는 `SECURE_COOKIES=1`을 넣지 않습니다. 호스트·Origin·프록시 구성이 어긋나면 로그인이 거부되거나 쿠키가 유지되지 않을 수 있습니다.

PC·태블릿은 해당 주소를 브라우저로 열면 됩니다. 모바일에서 다시 열 때도 관리자 로그인이 필요할 수 있으며, 이것은 별도 전자책 앱용 DB 연결 기능을 의미하지 않습니다.

## 다시 실행·중지·환경 점검

| 방식              | 실행/점검                                        | 정상 중지                                |
| ----------------- | ------------------------------------------------ | ---------------------------------------- |
| Windows           | `start.ps1`, `start.ps1 --check`                 | 실행 창에서 Ctrl+C                       |
| 일반 Linux 터미널 | `bash start.sh`, `bash start.sh --check`         | 실행 창에서 Ctrl+C                       |
| systemd           | `systemctl start/status novel-collector.service` | `systemctl stop novel-collector.service` |

서비스 조작은 필요에 따라 sudo를 사용합니다. 실행 중인 서버가 없으면 예약 수집도 진행되지 않습니다.

시작 스크립트는 같은 설치 폴더의 기존 인스턴스를 확인하고 정상 종료한 뒤 다시 시작합니다. 다른 설치나 무관한 Node 프로세스를 종료하지 않습니다. 이전 버전이 이 교체 규약을 지원하지 않으면 처음 한 번 기존 창에서 Ctrl+C로 종료하세요. 업데이트 진행 중에는 중복 실행하지 않습니다.

Node가 PATH에 있는 개발 환경에서는 다음 공통 실행기도 사용할 수 있습니다. 포터블 설치만 한 경우에는 위 시작 스크립트를 사용합니다.

```sh
node run.mjs --help
node run.mjs --check
node run.mjs --setup
node run.mjs --no-setup
```

`--setup`은 필요한 앱 런타임 준비만 하고 종료합니다. OS 라이브러리·실행 계정 권한까지 준비하는 첫 설치 스크립트와 같은 작업은 아닙니다. `--check`는 설치 없이 점검, `--no-setup`은 설치 없이 서버 실행입니다. `npm start/setup/check`는 Node와 npm이 준비된 개발 환경에서 같은 실행기를 호출합니다.

## 관리자 비밀번호를 잊었을 때

### 웹에서 로컬 복구

설치한 컴퓨터의 **직접 loopback 주소**에서 로그인 화면의 복구 안내를 엽니다. 예: `http://127.0.0.1:8788`.

1. 변경 범위와 모든 관리자 로그인 종료 경고를 확인합니다.
2. 확인 문구 `관리자 비밀번호 초기화`를 입력합니다.
3. 초기화를 실행하고 **새 접속 정보 파일 저장**을 누릅니다.
4. 파일 저장을 확인한 뒤 새 비밀번호로 직접 로그인합니다.

LAN IP·공개 도메인·역방향 프록시에서는 이 초기화를 허용하지 않습니다. 로컬 주소여도 프록시 전달 헤더가 있으면 거부합니다. 복구는 자동 로그인하지 않습니다.

### 원격 서버의 수동 복구

서버 관리자가 프로그램을 **먼저 정상 종료**한 뒤 설치 폴더의 복구 도구를 실제 실행 계정으로 사용합니다. 다음은 위 Linux 서비스 예시와 같은 설치의 명령입니다.

```sh
sudo systemctl stop novel-collector.service
cd /opt/novel-collector
sudo -u novelcollector env PATH="/opt/novel-collector/.runtime/node/bin:$PATH" node tools/reset-admin.mjs --root . --service-stopped --confirm "관리자 비밀번호 초기화"
sudo systemctl start novel-collector.service
```

복구 도구는 정확한 확인 문구·서비스 중지 확인을 요구하고 실행 중인 설치를 거부합니다. 새 비밀번호를 명령 출력에 쓰지 않으며 `secrets/admin-login.txt`에서 확인합니다. 설치 경로·서비스 이름·실행 계정은 실제 값으로 맞춥니다.

Windows 터미널 실행은 기존 창을 Ctrl+C로 종료한 후 같은 Windows 계정의 설치 폴더에서 실행할 수 있습니다.

```powershell
$env:PATH = (Join-Path $PWD '.runtime\node') + ';' + $env:PATH
node .\tools\reset-admin.mjs --root . --service-stopped --confirm "관리자 비밀번호 초기화"
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

복구는 관리자 비밀번호·관리자 세션만 변경합니다. 작품·회차·예약·프리셋·사이트 계정·브라우저 프로필은 유지됩니다. 파일을 저장하지 못했다면 안내 창을 닫기 전에 저장을 다시 시도하세요. DB나 `secrets` 폴더를 삭제해서 복구하지 않습니다.

## 자료 보관과 설치 이동

| 폴더                          | 보관할 내용                                         |
| ----------------------------- | --------------------------------------------------- |
| `data/`                       | 작품·회차·예약·설정·프리셋·로그                     |
| `secrets/`                    | 관리자 인증과 사이트 계정 암호화에 필요한 개인 정보 |
| `profile/`                    | 서버 브라우저 로그인 상태·캐시                      |
| `.updates/`                   | 설치 버전·업데이트 상태·복구 기록                   |
| `.runtime/`, `.venv-captcha/` | 설치 컴퓨터용 실행 환경                             |

작품 TXT/ZIP을 내려받는 것은 프로그램 설정과 인증까지 백업한 것이 아닙니다. 설치 전체를 옮길 때는 정상 종료 후 개인 영역을 함께 보존하고, 실행 계정 권한을 유지합니다. Windows와 Linux 사이에서는 런타임·브라우저를 다시 준비해야 하며 기존 브라우저 로그인이 그대로 사용된다고 가정하지 않습니다.

기존 설치 업데이트는 [대시보드 업데이터](UPDATE.md)를 사용합니다. 새 릴리스 압축을 개인 데이터 위에 통째로 덮어쓰지 않습니다. 백업 파일에는 비밀번호·계정·쿠키가 포함될 수 있으므로 공개 저장소나 이슈에 첨부하지 않습니다.

## 설치 완료 확인

- 실행 창 또는 서비스가 정상 실행 중입니다.
- 실제 수신 포트의 대시보드를 열고 관리자 비밀번호로 로그인할 수 있습니다.
- **관리 → 설정**에서 비밀번호를 변경하고 필요한 사이트 계정을 등록했습니다.
- 작품 한 개를 선택/예약하고 **작품 보관함**에 실제로 저장된 회차가 표시되는지 확인합니다.
- [이용 매뉴얼](DASHBOARD.md)을 따라 읽기·다운로드·실패 재수집을 사용합니다.

설치 환경 점검과 원본 사이트에서 실제로 수집 가능한지는 별개의 확인입니다. 실패 상태에서는 [문제 해결](TROUBLESHOOTING.md)을 참조하세요.

## 수집 전용 테더링 (Linux)

**대시보드의 기존 인터넷을 유지하고 원본 사이트 요청만 Android USB 테더링으로 분리**하는 선택 기능입니다. 일반 설치의 설정이나 서버의 기본 인터넷 경로를 자동으로 변경하지 않습니다.

### 지원 조건과 권한

- 휴대전화 호스트의 관리자 소유 게이트웨이와 전용 네트워크 영역이 필요합니다. 웹 서비스는 일반 계정을 유지하며 아래 Unix 소켓 연결을 사용합니다. 관리자가 직접 제어 도구를 실행하는 개발 시험도 지원합니다.
- 일반 계정 수집기를 이 기능 때문에 관리자 계정으로 바꾸거나 광범위한 sudo 권한을 부여하지 마세요. 권한이 충족되지 않은 채 전용 모드를 켜면 **수집만 연결 대기**로 남습니다.
- Android 휴대전화가 USB ADB로 이미 승인되어 있고 기존 Hermes 앱·브리지가 연결되어 있어야 합니다. 새 페어링이나 인증 우회는 수행하지 않습니다.
- 이동통신 데이터와 데이터 전송 가능한 USB 케이블이 필요합니다. Wi‑Fi에 연결된 휴대전화는 집 인터넷을 공유할 수 있으므로 준비 과정에서 Wi‑Fi를 끄고 검증된 이동통신망을 확인합니다.
- 서버에 기존 Node22 이상, iproute·udev 도구와 DHCP 클라이언트가 필요합니다. Rocky의 DHCP 클라이언트 패키지 설치 예시입니다.

    sudo dnf install dhcp-client

### 기존 서비스의 비공개 환경 설정

다음 경로와 USB 식별자는 **예시이며 실제 설치와 승인된 장치 값으로 바꿉니다.** 인증 토큰을 소스·공개 문서·설정 내보내기 파일에 넣지 않습니다.

    NC_COLLECTION_TETHER=1
    NC_TETHER_PHONE_SERIAL=ANDROID_USB_SERIAL
    NC_TETHER_PYTHON=/opt/hermes/android_agent/.venv/bin/python
    NC_HERMES_ROOT=/opt/hermes/android_agent
    NC_HERMES_BRIDGE_URL=http://127.0.0.1:18750

위 식별자·Python 경로 설정은 관리자 직접 실행 시험 또는 게이트웨이 환경에만 적용합니다. 일반 계정 웹 서비스에는 아래 Unix 소켓 설정만 적용합니다. USB 식별자는 기존 승인된 장치 목록에서 확인합니다. Python과 Hermes 경로는 기존 설치를 사용하며 브리지 인증은 해당 설치의 기존 설정으로 처리합니다.

### 최초 연결 순서

1. 기존 유선 인터넷과 서버 관리 연결을 유지합니다.
2. **휴대전화 테더링을 먼저 켜지 말고**, 관리자가 동일 환경과 기존 Node 실행 파일로 아래 전용 영역 준비를 먼저 수행합니다. 설치 폴더는 예시입니다.

       NC_TETHER_PHONE_SERIAL=ANDROID_USB_SERIAL node /opt/novel-collector/src/tether-host.mjs prepare

   관리자 실행 환경에서 사용합니다. 기존 유선 기본 경로와 다른 USB 장치를 바꾸지 않으며 소유권을 확인할 수 없는 기존 영역·설정은 덮어쓰지 않습니다.

3. 정상 준비된 기존 서비스에 비공개 환경 설정을 적용한 뒤 **설정 → 수집 연결 → 테더링 연결 확인**을 누릅니다.
4. 연결 준비는 전용 영역 준비 확인 → Hermes의 이동통신망 준비 → USB 테더링 켜기 → 해당 USB 네트워크 경로 구성 → USB·테더링·검증된 이동통신망 확인 순서입니다.
5. **휴대전화 테더링 연결됨** 상태가 된 뒤 수집합니다. 대기·확인 필요 상태에서는 기존 인터넷으로 대신 수집하지 않습니다.

수집 브라우저와 브라우저 밖 썸네일 요청을 같은 전용 프록시로 연결합니다. 전용 영역의 IPv4 경로와 DNS를 휴대전화로 분리하고 그 영역의 IPv6는 비활성화합니다. 대시보드·저장 파일 제공·업데이트는 기존 연결에 남습니다.

### 연결 단절·차단 복구

- USB·테더링 단절 시 수집을 대기로 전환하고 저장 회차를 보존합니다. 수동 일시정지는 자동 해제하지 않습니다.
- 정확한 IP 대역 차단일 때만 종료 확인 → 저장 시각 기준5분 대기 → 다시 켜기 → 경로 확인 후 재시도를 수행합니다. 일반 CAPTCHA나 모든403 응답으로 휴대전화를 반복 조작하지 않습니다.
- 자동 복구 뒤 같은 차단이 반복되거나 Hermes 제어·이동통신망 확인에 실패하면 대기 상태를 유지합니다. 관리자가 원인을 확인한 뒤 연결 확인 버튼으로 다시 준비합니다.
- 재연결로 공인 IP가 바뀌거나 차단이 해제되는 것을 보장하지 않습니다.

### 수집기와 휴대전화가 다른 호스트일 때

웹 서비스의 실행 계정을 root로 바꾸거나 sudo·관리자 SSH 키를 주지 않습니다. 휴대전화가 연결된 Linux 호스트에 관리자 소유 게이트웨이를 두고, 기존에 인증된 SSH 연결로 **두 Unix 소켓만 역방향 전달**합니다. 새 외부 TCP 포트나 SSH 키를 만들지 않습니다.

- 휴대전화 호스트: 관리자만 읽고 수정할 수 있는 `/opt/novel-collector-gateway`에 검수한 게이트웨이 소스를 설치합니다. `deploy/novel-collector-tether.service`는 이 호스트용 예제이며, 웹 서비스용 예제가 아닙니다.
- 대시보드 호스트: `deploy/novel-collector-tether.tmpfiles.conf`의 기존 서비스 그룹을 확인한 뒤 관리자가 런타임 폴더를 준비합니다. 게이트웨이는 자신이 만든 두 소켓만 `0660`으로 설정하며, 외부·교체 소켓은 건드리지 않습니다.
- 게이트웨이 비공개 환경 파일에는 `NC_TETHER_PHONE_SERIAL`, `NC_TETHER_HELPER_ROOT`, `NC_TETHER_PYTHON`, 기존 Hermes 연결 설정을 둡니다. `NC_TETHER_EXPORT_TARGET`은 기존 키로 접속 가능한 **대시보드 호스트의 SSH 별칭**이며, `NC_TETHER_EXPORT_GROUP`은 기존 웹 서비스 그룹입니다.
- 웹 서비스에는 아래 연결 설정만 필요합니다. 휴대전화 식별자·Hermes 인증값·SSH 키는 필요하지 않습니다.

```ini
NC_COLLECTION_TETHER=1
NC_TETHER_CONTROL_SOCKET=/run/novel-collector-tether/control.sock
NC_TETHER_PROXY_SOCKET=/run/novel-collector-tether/proxy.sock
```

운영 적용 전 실제 웹 서비스 사용자로 두 소켓 접근을 확인합니다. 역방향 전달의 이전 소켓이나 알 수 없는 파일이 있으면 자동으로 지우지 않고 대기하므로, 관리자가 소유 프로세스와 경로를 확인해야 합니다. 서비스 예제와 환경 파일은 업데이트 ZIP에 포함돼도 자동 설치·실행되지 않습니다.

### 공통 휴대전화 작업 큐와 앱 요구사항

Instagram 피드·릴스는 앱 열기부터 복구·최종 확인·정리까지 한 작업 임대를 사용합니다. 코레일의 휴대전화 화면 조작과 테더링도 같은 FIFO 큐에 들어갑니다. 휴대전화를 사용하지 않는 서버 API 예약 조회는 휴대전화 잠금을 잡지 않습니다. 테더링 종료와 재시작은 별도 작업이며, 그 사이 **5분 대기에는 휴대전화를 점유하지 않습니다**.

자동 테더링에는 기존 인증을 사용하는 Hermes 공통 작업 API(`/phone/tasks/begin`, `status`, `heartbeat`, `end`)와 SDK의 `phone_task(..., strict=True)`가 필요합니다. 이동통신망 준비와 USB 켜기는 하나의 임대에서 처리하며, 테더링 종료 후 5분 대기에는 임대를 보유하지 않습니다. 작업 임대를 얻지 못하면 수집을 대기하며 무임대 실행으로 대체하지 않습니다.

테더링은 Android의 고정 네트워크 API인 `svc wifi disable`과 `svc usb setFunctions`만 사용합니다. USB 켜기는 검증된 `rndis`, 끄기는 관리자 전용 파일에 보존한 원래 단일 기능을 사용합니다. 원래 값을 확인할 수 없는 기존 테더링은 검증된 안전한 `mtp` 복원만 허용하며 `adb`를 포함한 임의 조합을 보내지 않습니다. 실제 USB 기능과 Android의 현재 `TetheredState`·오류 없음, 검증된 이동통신망을 모두 확인합니다.

기존에 승인된 USB 디버깅 연결과 Android 셸의 해당 네트워크 권한이 필요합니다. OS가 거부하면 수집만 대기하며 추가 권한·페어링·보안 설정 변경으로 우회하지 않습니다. 잠긴 화면을 클릭하거나 해제할 필요는 없지만, OS가 잠금 중 USB 변경을 제한하면 역시 대기합니다. 활성 통화가 확인되면 Wi-Fi를 끄지 않습니다.

테더링 경로에는 화면 열기·조회·좌표 탭이 없습니다. 따라서 `expected_package_guard`는 이 네트워크 기능의 의존 조건이 아닙니다. 일반 Hermes UI 조작의 기존 화면 검사와 접근성·개인정보 보호 설정은 그대로 유지합니다.

현재 설치 앱에 기능이 없으면 동일 서명·기존 데이터 보존·추가 요청 권한 유무를 검수한 업데이트로 준비합니다. 앱을 삭제하거나 재페어링하여 기존 인증을 덮어쓰지 않습니다. Hermes 브리지·SDK·기존 게시 스크립트 변경은 웹 업데이트와 별도 배포 대상이므로, 각각 기존 파일 체크섬과 백업을 확인한 뒤 적용합니다.
