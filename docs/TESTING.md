# 검증 현황

검증 기준: 2026-10-03. 테스트는 임시 저장소와 합성 fixture를 사용합니다. CAPTCHA 브라우저 테스트는 격리된 로컬 서버만 호출합니다.

| 범위 | 결과 |
|---|---|
| 기존 구현 비교 실행 | 408개 중 376 통과, 32 실패 |
| CAPTCHA 확장 후 전체 | 435개 중 403 통과, 32 실패 |
| 추가 CAPTCHA Node 테스트 | 27/27 통과 |
| 이미지·오프라인 평가 Python 테스트 | 6/6 통과 |

기존 구현 비교는 새 연결 코드를 메모리 load hook에서 제거해 수행했으며 운영 파일을 덮어쓰지 않았습니다. 변경 전후 실패 테스트 이름은 동일했습니다. 따라서 전체 테스트가 모두 통과한 상태는 아닙니다.

기존 실패 분포: discovery-gate 4, discovery 4, job-profiles-http 3, job-profiles 3, library-metadata 6, site-auto-auth 2, site-browser 5, ui-site-account 1, ui-site-verification 2, viewer-origins 2. 소스 사이트 전환과 오래된 mock 계약의 불일치를 기능별로 정리해야 합니다.

새 테스트는 조건부 실행, 동시 응답 합류, 세션 변경, 챌린지 만료, 불명확한 위치, trail 시간 범위, 본문 없는 발급, 현재 쿠키, 성공 토큰 검증, 타임아웃·거부·재요구의 반복 차단, 기존 처리기의 새 nonce/proof 생성, 사람 확인 인계, 이미지 디코딩·크기·오차와 평가 지표를 확인합니다.

합성 위치 표본 8개는 모두 원래 x를 정확히 산출했습니다. 이 결과는 실제 서버의 CAPTCHA 통과율을 의미하지 않습니다. 운영 이미지 평가 및 서버 검증 성공률은 별도로 측정합니다.

후속 보완에서는 단색 빈칸의 alpha 외곽 매칭과 서브픽셀 peak 보간을 추가했습니다. 해당 변경 후 CAPTCHA Node 테스트 **28/28**, Python 이미지·평가 테스트 **9/9**가 통과했습니다. 원래 8개 질감 표본은 0.5픽셀 이내, 새 단색 표본 3개는 2픽셀 이내 위치를 산출했으며, 중복 빈칸은 제출을 보류합니다. 실제 브라우저의 소수점 x와 소수 밀리초 timestamp 보존도 검사합니다. 위 전체 테스트 표는 이 보완 전의 전체 실행 기준선입니다.

```sh
npm test
npm run test:captcha
npm run test:captcha:images
```

Python 테스트 전 `requirements-captcha.txt`의 의존성을 `.venv-captcha`에 설치하세요. 브라우저 테스트는 `BROWSER_PATH`로 지정한 Chromium 또는 로컬 설치 경로의 Chromium을 사용합니다.
