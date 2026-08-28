const NOTION_TEMP_PATTERN = /^notion-temp/i;

/**
 * notion-temp 형식의 값을 빈 표시("-")로 대체한다.
 * 일반 값은 그대로 반환한다.
 */
export function filterNotionTemp(value: string | null | undefined): string {
  if (!value) return "";
  if (NOTION_TEMP_PATTERN.test(value.trim())) return "";
  return value;
}
