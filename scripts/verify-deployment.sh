#!/usr/bin/env bash
# scripts/verify-deployment.sh — **은퇴한 도구다(묘비).** 실행하면 항상 실패하고 대체 경로를
# 알려준다. 0 을 낼 수 있는 경로는 이 파일에 없다 — 그게 이 묘비의 존재 이유다.
#
# ── 왜 은퇴했나 ──────────────────────────────────────────────────────────────
# 이 스크립트는 "환각 방지용" 배포 검증기로 태어났지만, 정작 **SHA·PR·브랜치를 전혀
# 참조하지 않았다.** `gh api repos/<slug>/deployments` 응답에서 가장 최근 Production
# 배포 하나(`[0]`)를 집을 뿐이라, 답하는 질문이 "**마지막** 프로덕션 배포가 건강한가"
# 이지 "**내** 커밋이 실렸나"가 아니었다.
#   실사고(2026-07-31, PR #205): 머지 직후 실행해 exit 0 · success 를 받았는데 집힌 것은
#   **이전 승격분**(deploy #201.202)이었다. 생성 시각이 내 머지보다 이르다는 걸 눈치채지
#   못했으면 "배포 성공"으로 오보고할 뻔했다.
#
# 그리고 2026-08-13 자체호스팅 컷오버로 이 결함이 **상시화**됐다. 이 스크립트가 조회하는
# GitHub Deployments 는 Vercel 이 만든 것이고, Vercel(release 브랜치)은 **롤백 창구 전용**
# 이 되어 전진을 멈췄다. 실측(2026-08-21): `[0]` 이 집는 것은 2026-08-15 에 만들어진
# release 팁 배포 하나로 고정돼 있고, 그 SHA 는 셀프호스트 마커가 가리키는 **실제 서빙
# 커밋과 다르다.** 즉 오늘 이 도구는 "틀린 질문에 답하는" 정도가 아니라 **엿새 묵은 배포
# 레코드를 근거로 매번 같은 초록을 돌려준다.**
#
# ── 대체 경로 ────────────────────────────────────────────────────────────────
# 판정 계약의 정본은 docs/agents/deployment.md(P6) 「Deployment Verification」 절이고,
# 그 두 단계를 그대로 자동화한 실행체가 scripts/await-promotion.sh 다.
#   · "내 PR 이 prod 에 있나"       → bash scripts/await-promotion.sh --check --pr <NN>
#   · 배포될 때까지 대기            → bash scripts/await-promotion.sh --watch --pr <NN>
#   · 롤백 창구(구 Vercel 플랫폼)   → ... --check <sha|ref> --lane vercel
# 그쪽은 **대상 SHA 를 받아 그 SHA 로 판정**하므로 위 결함이 원리적으로 없고, 마커를 못
# 읽는 환경에서는 「판정 불가(exit 5)」를 미배포와 구분해 돌려준다.
#
# ⛔ 이 파일을 "고쳐서" 되살리지 말 것 — 마커 판정을 여기에 다시 구현하면
#   await-promotion.sh 가 소유한 SSOT 의 **두 번째 손수 사본**이 된다(이 레포의 반복 결함).
#   되살릴 사유가 생기면 아래 선언과 P6·AGENTS.md 의 기계 마커를 **함께** 고쳐야 한다 —
#   scripts/__tests__/verify-deployment-doc-parity.contract.test.ts 가 그 짝을 강제한다.

# 문서 정합 계약이 읽는 기계 선언. 값이 바뀌면 문서 두 절의 마커도 함께 바뀌어야 한다.
VERIFY_DEPLOYMENT_STATUS="retired"

# 🪤 안내문을 파이프로 흘리지 않는다(heredoc 직접 리다이렉트) — 이 레포는 종료코드가 판정인
#   스크립트에서 먼저 끝나는 소비자를 파이프에 뒀다가 생산자가 SIGPIPE(141)로 죽는 사고를
#   겪었다(promote-prod-check.test.ts 가 promote-prod.sh·await-promotion.sh 에 그 형태를
#   금지한다). 이 묘비의 유일한 계약도 "절대 0 을 내지 않는다"라 같은 규율을 따른다.
cat >&2 <<'RETIRED'
⛔ scripts/verify-deployment.sh 는 은퇴했다 (상태: retired).

  이 도구는 SHA 를 참조하지 않고 "가장 최근 Production 배포" 하나만 집었다. 2026-08-13
  셀프호스팅 컷오버 이후 그 레코드는 롤백 창구(Vercel)에 멈춰 있어, 무엇을 물어도 같은
  낡은 초록을 돌려준다 — 그대로 두면 P0 「No Hallucinated Verification」 을 어기는
  성공 오보고가 난다.

  대신 이것을 쓴다:
    bash scripts/await-promotion.sh --check --pr <NN>          # 내 PR 이 prod 에 있나
    bash scripts/await-promotion.sh --watch --pr <NN>          # 실릴 때까지 대기
    bash scripts/await-promotion.sh --check <sha|ref> --lane vercel   # 롤백 창구 판정

  종료코드: 0=실림 · 3=아직 · 5=판정 불가(마커 없음 — 미배포가 아니다) · 1=오류
  판정 계약 정본: docs/agents/deployment.md(P6) 「Deployment Verification」
RETIRED

exit 1
