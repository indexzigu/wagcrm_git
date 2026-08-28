// 주민등록번호 암호화 키 정합 감사 — 저장된 값이 **지금 이 프로세스의**
// `ENCRYPTION_KEY` 로 열리는지 주기 점검한다.
//
// 배경(2026-08-13 실사고) — **화면은 그냥 빈칸이었다.**
// 셀프호스팅 컷오버 때 `ENCRYPTION_KEY` 가 컷오버 전 값과 달라져 셀러 몇 명의
// `Seller.residentNumber` 가 현재 키로 열리지 않는 상태가 됐다. 그런데 대량 조회 경로는
// 설계상 `decryptOrNull()` 을 쓴다 — 한 행이 안 열린다고 페이지·프리렌더를 죽이면 피해가
// 원인보다 크기 때문이다(그 설계는 유지해야 한다). 그래서 실패는 `console.warn` 한 줄로
// 남고 화면에는 빈칸으로 보였고, **우연히 빌드 프리렌더 로그를 읽다가** 발견됐다.
//
// 즉 이것은 `db-exposure-audit` 과 같은 부류다 — 열화가 무증상이라 **사람이 알아차릴
// 계기가 존재하지 않는다.** 그래서 기계가 센다.
//
// ⚠️ **왜 로컬 스크립트로는 안 되는가:** 스크립트를 개발 머신에서 돌리면 검사되는 쌍은
// 레포 `.env` 의 DB × 로컬 `ENCRYPTION_KEY` 다. 그런데 깨진 것은 **배포된 프로세스의**
// env × 프로덕션 DB 쌍이었다(두 DB 는 서로 다른 실물이다). 감사기가 의미를 가지려면
// 앱이 실제로 쓰는 그 쌍 안에서 돌아야 한다 — 그래서 크론 라우트다.
//
// 읽기 전용이다. 복호화 결과는 `classifyDecryptability` 안에서 즉시 버려지므로 이 모듈은
// 평문을 한 번도 손에 쥐지 않고, 보고에는 **개수와 셀러 id** 만 담는다(값·키 금지).
import { classifyDecryptability } from "./encryption";
import { isSqliteDatabaseUrl } from "./prisma-client";

/** 이력(`SystemTaskLog.details`)이 비대해지지 않게 id 나열 상한을 둔다. */
export const MAX_REPORTED_SELLER_IDS = 20;

export type EncryptionAuditTally = {
  /** 셀러 전체 수 — 감사기가 대상 DB 를 보고 있는지의 양성 대조군. */
  sellersScanned: number;
  /** `residentNumber` 가 채워진 행 수. */
  stored: number;
  /** 현재 키로 열리는 행 수(정상). */
  currentKey: number;
  /** 구 키로만 열리는 행 수(재암호화 미완). */
  previousKeyOnly: number;
  /** 암호문 형식이 아닌 행 수(암호화된 적 없는 평문). */
  plaintext: number;
  /** 어느 키로도 안 열리는 행 수. */
  unreadable: number;
  /** 값이 아니라 **id** 만(최대 `MAX_REPORTED_SELLER_IDS`개). */
  unreadableSellerIds: string[];
  previousKeySellerIds: string[];
};

export type EncryptionAuditResult =
  | { status: "skipped"; reason: string }
  | { status: "broken"; reason: string }
  | ({ status: "empty"; reason: string } & EncryptionAuditTally)
  | ({ status: "ok" } & EncryptionAuditTally)
  | ({ status: "degraded"; summary: string } & EncryptionAuditTally);

/**
 * 감사에 필요한 읽기 두 개만 좁게 받는다 — Prisma 클라이언트를 그대로 받지 않는 이유는
 * 이 판정을 DB 없이 테스트로 고정하기 위해서다(어댑터는 크론 라우트가 만든다).
 */
export type ResidentNumberAuditSource = {
  countSellers: () => Promise<number>;
  /** `residentNumber` 가 null 이 아닌 행의 `{ id, value }` 전량. */
  listStoredValues: () => Promise<{ id: string; value: string | null }[]>;
};

/**
 * 집계 → 최종 판정. 순수 함수라 계약 테스트가 DB 없이 고정한다.
 *
 * 판정 축이 왜 이렇게 갈리는가:
 * - `sellersScanned === 0` → **`broken`(감사 불능)**. 셀러가 0명인 CRM 은 운영 상태가
 *   아니므로, 위반 0건이 아니라 감사기가 엉뚱한(빈) DB 를 보고 있다는 뜻이다.
 *   `db-exposure-audit` 의 "테이블 0개는 깨끗함이 아니다" 와 같은 판정이다.
 * - `stored === 0` → **`empty`(실패 아님)**. 위와 달리 이쪽은 **정상일 수 있다** —
 *   주민등록번호는 개인 셀러 원천징수용이라 한 건도 없는 시점이 실재한다. 여기서
 *   빨강을 띄우면 "매일 빨강"이 되어 신호가 습관화로 죽는다(그 대가가 더 크다).
 *   대신 사유를 본문에 남겨 "감사기가 아무것도 검사하지 못했다"가 이력에 보이게 한다.
 * - `plaintext > 0` → **빨강으로 올리지 않는다.** 축이 다른 문제다(암호화된 적 없는 값 =
 *   저장 위생). 재암호화 스크립트가 "이참에 암호화" 대상으로 다루는 부류이고, 키 정합
 *   신호에 섞으면 둘 다 흐려진다. 개수만 보고한다.
 * - `previousKeyOnly > 0` → **빨강**. 화면은 멀쩡해 보이지만(구 키로 열린다) 전환이
 *   끝나지 않은 상태이고, `ENCRYPTION_KEY_PREVIOUS` 를 제거하는 순간 그 행들이 이번
 *   사고와 똑같이 빈칸이 된다. 교체 런북 3~5단계를 도는 몇 분간은 빨강이 정상이다(P6).
 */
export function evaluateEncryptionAudit(tally: EncryptionAuditTally): EncryptionAuditResult {
  if (tally.sellersScanned === 0) {
    return {
      status: "broken",
      reason:
        "셀러를 한 명도 못 봤다. 복호화 실패 0건이 아니라 감사기가 대상 DB 를 못 보는 상태다(연결 대상 확인 필요).",
    };
  }

  if (tally.stored === 0) {
    return {
      ...tally,
      status: "empty",
      reason: `셀러 ${tally.sellersScanned}명 중 주민등록번호가 저장된 행이 0건이다. 검사할 대상이 없었을 뿐이므로 실패는 아니다.`,
    };
  }

  const problems: string[] = [];
  if (tally.unreadable > 0) {
    problems.push(`현재·구 키 어느 쪽으로도 열리지 않는 행 ${tally.unreadable}건`);
  }
  if (tally.previousKeyOnly > 0) {
    problems.push(`구 키로만 열리는 행 ${tally.previousKeyOnly}건(재암호화 미완)`);
  }

  if (problems.length === 0) return { ...tally, status: "ok" };

  return {
    ...tally,
    status: "degraded",
    summary: `${problems.join(" · ")} / 저장 ${tally.stored}건 중`,
  };
}

/**
 * 실제 감사 실행. sqlite·데모 레인은 조용히 건너뛴다 — 그 DB 에는 프로덕션 키로 암호화된
 * 행이 애초에 없어서 실패로 찍으면 거짓 경보가 된다(데모 프로젝트 레이더가 매일 빨강).
 */
export async function runEncryptionKeyAudit(
  source: ResidentNumberAuditSource,
  databaseUrl = process.env.DATABASE_URL,
): Promise<EncryptionAuditResult> {
  if (isSqliteDatabaseUrl(databaseUrl)) {
    return { status: "skipped", reason: "sqlite·데모 레인: 프로덕션 키로 암호화된 행이 없다." };
  }

  // 키 자체가 없으면 전 행이 "안 열림"으로 나오는데, 그건 데이터 문제가 아니라 설정
  // 문제다. 사유를 갈라 두지 않으면 오너가 재암호화 스크립트를 찾아 헤맨다.
  if (!process.env.ENCRYPTION_KEY?.trim()) {
    return {
      status: "broken",
      reason:
        "ENCRYPTION_KEY 가 이 프로세스에 설정돼 있지 않다. 저장된 값을 열 수도, 새로 저장할 수도 없다(폴백 키는 없다).",
    };
  }

  const sellersScanned = await source.countSellers();
  const rows = await source.listStoredValues();

  const tally: EncryptionAuditTally = {
    sellersScanned,
    stored: 0,
    currentKey: 0,
    previousKeyOnly: 0,
    plaintext: 0,
    unreadable: 0,
    unreadableSellerIds: [],
    previousKeySellerIds: [],
  };

  for (const row of rows) {
    const grade = classifyDecryptability(row.value);
    // "빈 문자열"은 저장된 값으로 세지 않는다 — `where: { not: null }` 를 통과하지만
    // 열 것이 없으므로 실패로 세면 오탐이다.
    if (grade === "empty") continue;
    tally.stored += 1;
    switch (grade) {
      case "current":
        tally.currentKey += 1;
        break;
      case "plaintext":
        tally.plaintext += 1;
        break;
      case "previous":
        tally.previousKeyOnly += 1;
        if (tally.previousKeySellerIds.length < MAX_REPORTED_SELLER_IDS) {
          tally.previousKeySellerIds.push(row.id);
        }
        break;
      case "unreadable":
        tally.unreadable += 1;
        if (tally.unreadableSellerIds.length < MAX_REPORTED_SELLER_IDS) {
          tally.unreadableSellerIds.push(row.id);
        }
        break;
    }
  }

  return evaluateEncryptionAudit(tally);
}
