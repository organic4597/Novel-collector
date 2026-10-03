# 업데이트와 복구

## 소스 업데이트

1. 대시보드에서 전체 일시정지하여 현재 작업을 정리합니다.
2. `data/`, `profile/`, `secrets/`를 접근 권한이 제한된 별도 위치에 백업합니다. 이 백업은 Git에 올리지 않습니다.
3. 현재 버전과 로컬 수정 여부를 확인합니다.

```sh
git status --short
git log -1 --oneline
git pull --ff-only
npm ci
uv pip install --python .venv-captcha/bin/python -r requirements-captcha.txt
```

4. 테스트하고 서비스를 재시작합니다.

```sh
npm run test:captcha
npm run test:captcha:images
sudo systemctl restart novel-collector.service
```

5. 대시보드에서 수동 일시정지 상태를 확인하고 전체 시작으로 재개합니다. 인증이 필요하면 기존 사이트 설정과 CAPTCHA 창을 사용합니다.

서비스 재시작은 저장한 회차를 삭제하지 않습니다. 완전성이 검증된 목차는 재개 시 재사용하며, CAPTCHA 재시도가 목차 스캔을 다시 수행하지 않습니다.

## 문제 발생 시

소스 버전과 데이터를 구분해 복구합니다. 태그 또는 이전 커밋으로 소스를 확인하려면 작업 중 변경 사항을 먼저 보관한 뒤 별도 경로에서 해당 버전을 검증합니다. `git reset --hard`나 저장 데이터 삭제를 업데이트 절차로 사용하지 않습니다.

로그 페이지와 `journalctl -u novel-collector.service`에서 오류를 확인합니다. CAPTCHA 이미지 임계값을 변경했다면 override의 값을 먼저 확인합니다. [문제 해결](TROUBLESHOOTING.md)도 참조하세요.
