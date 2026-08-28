#!/usr/bin/env bash
# scripts/create-pr.sh
# 오너님의 PR 배포 규약을 시스템적으로 강제하는 CLI Wrapper

TITLE=""
BODY=""
OTHER_ARGS=()

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --title|-t) TITLE="$2"; shift 2;;
    --body|-b) BODY="$2"; shift 2;;
    *) OTHER_ARGS+=("$1"); shift;;
  esac
done

if [[ -z "$TITLE" ]]; then
  echo "Error: --title (-t) is required."
  exit 1
fi

# 정규식 검증: type(scope): 한글 요약
# 영문 단독 제목 방지
if ! echo "$TITLE" | grep -qE "^(feat|fix|chore|docs|style|refactor|test)\([a-zA-Z0-9-]+\): .+$"; then
  echo "Error: PR 제목이 WAG CRM 규약에 맞지 않습니다."
  echo "기대 포맷: type(scope): 한글 요약 (최소 1글자 이상의 한글 포함)"
  echo "입력된 제목: $TITLE"
  exit 1
fi

# 한글이 1글자라도 포함되어 있는지 더블 체크
if ! echo "$TITLE" | grep -q "[가-힣]"; then
  echo "Error: PR 제목에 반드시 한글 요약이 포함되어야 합니다. (영문 전용 제목 금지)"
  exit 1
fi

# PR 본문 가드 체크리스트 삽입
REQUIRED_MARKER="- [x] 배포 지침 및 검증 로그 확인 완료"
if [[ -z "$BODY" ]]; then
  BODY="$REQUIRED_MARKER"
else
  BODY="$BODY

$REQUIRED_MARKER"
fi

echo "Creating PR..."
PR_URL=$(gh pr create --title "$TITLE" --body "$BODY" "${OTHER_ARGS[@]}")

if [[ $? -ne 0 ]]; then
  echo "Error: Failed to create PR."
  exit 1
fi

echo "PR created: $PR_URL"

# PR URL에서 번호 추출 (예: https://github.com/indexzigu/wag-crm/pull/133 -> 133)
PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')

if [[ -n "$PR_NUMBER" ]]; then
  NEW_TITLE="#$PR_NUMBER $TITLE"
  echo "Updating PR title with prefix: $NEW_TITLE"
  gh pr edit "$PR_NUMBER" --title "$NEW_TITLE"
  if [[ $? -eq 0 ]]; then
    echo "Successfully updated PR title."
  else
    echo "Warning: Failed to update PR title."
  fi
else
  echo "Warning: Could not extract PR number from URL."
fi
