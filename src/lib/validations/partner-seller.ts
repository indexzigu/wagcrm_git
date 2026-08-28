import { PARTNER_TYPES, type PartnerType } from "./partner";
import { SNS_TYPES, type SnsType } from "./seller";

export type AddCategoryTagResult = {
  success: boolean;
  tags: string[];
  error?: string;
};

export type ValidationResult = {
  valid: boolean;
  error?: string;
};

export type MultiValidationResult = {
  valid: boolean;
  errors: Record<string, string>;
};

/**
 * 사업자번호 유효성 검증
 * - 빈 문자열: 유효 (선택 필드)
 * - 정확히 10자리 숫자: 유효
 * - 그 외: 무효
 */
export function validateBusinessNumber(input: string): ValidationResult {
  if (input === "") return { valid: true };
  if (/^\d{10}$/.test(input)) return { valid: true };
  return { valid: false, error: "사업자번호는 10자리 숫자여야 합니다." };
}

/**
 * 채널 URL 유효성 검증
 * - http:// 또는 https://로 시작하는 비어있지 않은 문자열만 유효
 */
export function validateChannelUrl(url: string): ValidationResult {
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return {
      valid: false,
      error: "유효한 URL을 입력해주세요. (http:// 또는 https://로 시작)",
    };
  }
  return { valid: true };
}

/**
 * 거래처 생성 유효성 검증
 * - 이름: 1자 이상 50자 이하, 공백만으로 구성되지 않음
 * - 유형: BRAND, VENDOR, AGENCY, AGENT, SELLER 중 하나
 */
export function validatePartnerCreation(input: {
  name: string;
  type: string;
}): MultiValidationResult {
  const errors: Record<string, string> = {};

  const trimmedName = input.name.trim();
  if (trimmedName.length === 0) {
    errors.name = "이름은 필수입니다.";
  } else if (trimmedName.length > 50) {
    errors.name = "이름은 50자 이하여야 합니다.";
  }

  if (!input.type || !PARTNER_TYPES.includes(input.type as PartnerType)) {
    errors.type = "유형을 선택해주세요. (BRAND, VENDOR, AGENCY, AGENT, SELLER)";
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors,
  };
}

/**
 * 셀러 생성 유효성 검증
 * - 조합 A: channelUrl이 유효한 URL (http:// 또는 https://로 시작)
 * - 조합 B: name(1자 이상) + snsType(INSTAGRAM/YOUTUBE) + snsHandle(1자 이상)
 * - 최소 하나의 조합을 만족해야 유효
 */
export function validateSellerCreation(input: {
  channelUrl?: string;
  name?: string;
  snsType?: string;
  snsHandle?: string;
}): MultiValidationResult {
  const errors: Record<string, string> = {};

  // Check Combination A: valid channel URL
  const combinationA =
    !!input.channelUrl &&
    (input.channelUrl.startsWith("http://") ||
      input.channelUrl.startsWith("https://"));

  // Check Combination B: name + snsType + snsHandle
  const hasName = !!input.name && input.name.trim().length >= 1;
  const hasValidSnsType =
    !!input.snsType && SNS_TYPES.includes(input.snsType as SnsType);
  const hasSnsHandle = !!input.snsHandle && input.snsHandle.trim().length >= 1;
  const combinationB = hasName && hasValidSnsType && hasSnsHandle;

  if (!combinationA && !combinationB) {
    // Neither combination is satisfied — provide specific errors
    if (input.channelUrl && !combinationA) {
      errors.channelUrl =
        "유효한 URL을 입력해주세요. (http:// 또는 https://로 시작)";
    }
    if (!hasName) {
      errors.name = "이름을 입력해주세요.";
    }
    if (!hasValidSnsType) {
      errors.snsType = "SNS 유형을 선택해주세요. (INSTAGRAM, YOUTUBE 또는 X)";
    }
    if (!hasSnsHandle) {
      errors.snsHandle = "SNS 핸들을 입력해주세요.";
    }

    // If no channelUrl was provided at all, add a general hint
    if (!input.channelUrl && !errors.channelUrl) {
      errors.channelUrl =
        "채널 URL 또는 이름+SNS유형+SNS핸들 조합을 입력해주세요.";
    }
  }

  return {
    valid: combinationA || combinationB,
    errors,
  };
}


/**
 * 연결된 셀러 검색 제외
 * - 전체 셀러 목록에서 이미 연결된 셀러를 제외한 결과를 반환
 * - id 기준으로 필터링
 */
export function filterLinkedSellers<T extends { id: string }>(
  allSellers: T[],
  linkedSellers: Array<{ id: string }>,
): T[] {
  const linkedIds = new Set(linkedSellers.map((s) => s.id));
  return allSellers.filter((seller) => !linkedIds.has(seller.id));
}

/**
 * 카테고리 태그 추가 (최대 개수 제한 적용)
 * - 현재 태그 수가 maxTags(기본 5) 이상이면 추가 거부
 * - 이미 존재하는 태그는 추가하지 않음 (중복 방지)
 * - 성공 시 새 태그가 추가된 배열 반환
 */
export function addCategoryTag(
  currentTags: string[],
  newTag: string,
  maxTags: number = 5,
): AddCategoryTagResult {
  if (currentTags.length >= maxTags) {
    return {
      success: false,
      tags: currentTags,
      error: `최대 ${maxTags}개 카테고리까지 추가할 수 있습니다.`,
    };
  }

  // Duplicate check (case-insensitive)
  const lowerNewTag = newTag.toLowerCase();
  if (currentTags.some((t) => t.toLowerCase() === lowerNewTag)) {
    return {
      success: false,
      tags: currentTags,
      error: "이미 추가된 카테고리입니다.",
    };
  }

  return {
    success: true,
    tags: [...currentTags, newTag],
  };
}
