import { describe, it, expect } from 'vitest';
import { isSupplementProduct, SUPPLEMENT_PRODUCT_CLASS } from '../product-class';

/**
 * `isSupplementProduct` 의 행위 계약.
 *
 * 이 판정이 틀리면 주문 라인이 메인/추가옵션 중 엉뚱한 쪽으로 흘러 매출·수량·주문수가
 * 갈리는데, 실패가 **조용하다**(집계에서 사라질 뿐 오류가 나지 않는다). 그래서 경계값을
 * 픽스처가 아니라 여기서 고정한다.
 */
describe('isSupplementProduct — 추가구성상품 판정', () => {
  it('NFC(조합형) 값을 참으로 본다 — 도입 시점 저장 데이터가 전부 이 형태였다', () => {
    // ⚠️ 「전부」의 근거는 저장 데이터 관측이라 레포 안에 없다 — 재현 방법은 SSOT 헤더.
    expect(isSupplementProduct({ productClass: '추가구성상품' })).toBe(true);
  });

  it('NFD(자모 분리형) 값도 참으로 본다 — 이 정규화가 없으면 조용히 메인으로 오분류된다', () => {
    const nfd = '추가구성상품'.normalize('NFD');
    // 프로브: 픽스처가 실제로 갈라져 있어야 이 단언에 의미가 있다.
    expect(nfd).not.toBe('추가구성상품');
    expect(nfd.length).toBeGreaterThan('추가구성상품'.length);

    expect(isSupplementProduct({ productClass: nfd })).toBe(true);
  });

  it('메인 품목 분류는 거짓이다', () => {
    // 메인 품목 쪽 분류값. 정규화가 이것까지 삼키면 안 된다.
    // ⚠️ 이 값의 출처는 저장 데이터 관측이고 레포 안에는 근거가 없다 — 재현 방법은
    //    `product-class.ts` 헤더에 있다(레포에서 검증 불가한 단정을 남기지 않기 위한 표시).
    expect(isSupplementProduct({ productClass: '조합형옵션상품' })).toBe(false);
  });

  it('값이 없거나 문자열이 아니면 거짓이다 — 종전 `=== 리터럴` 과 같은 처분', () => {
    expect(isSupplementProduct({})).toBe(false);
    expect(isSupplementProduct({ productClass: null })).toBe(false);
    expect(isSupplementProduct({ productClass: undefined })).toBe(false);
    expect(isSupplementProduct(null)).toBe(false);
    expect(isSupplementProduct(undefined)).toBe(false);
    // 런타임 값은 `any` 로 흘러 들어온다(스냅샷 JSON) — 타입만 믿을 수 없다.
    expect(isSupplementProduct({ productClass: 123 } as never)).toBe(false);
  });

  it('공백·대소문자는 뭉개지 않는다 — 분류 enum 이라 정확 일치 자리다', () => {
    // ⛔ 여기가 참으로 바뀌면 `normalizeForCompare` 로 갈아탄 것이다. P7 Valid-Order Enum
    //    Discipline("네이버 enum 과 문자열까지 정확히 일치")에 어긋난다.
    expect(isSupplementProduct({ productClass: '추가 구성 상품' })).toBe(false);
    expect(isSupplementProduct({ productClass: ' 추가구성상품' })).toBe(false);
    expect(isSupplementProduct({ productClass: '추가구성상품 ' })).toBe(false);
  });

  it('NFC 입력에서는 종전 리터럴 비교와 결과가 같다 — 이 리팩터가 수치를 바꾸지 않는 근거', () => {
    // 새 판정이 옛 판정과 갈리는 입력은 **NFC 가 아닌 형태**뿐이다(NFC 문자열에 `toNfc` 는
    // 항등이고, 비문자열은 양쪽 다 거짓). 그래서 NFC 코퍼스에서 두 판정이 일치하면
    // "정규화를 얹어도 집계가 안 바뀐다"가 성립한다.
    //
    // 도입 시점 저장 데이터 대조에서도 갈리는 행은 없었다(재현 방법은 SSOT 헤더).
    // ⚠️ 그 대조는 **그 시점의 데이터**에 대한 것이지 미래 보증이 아니다 — 네이버가 NFD 로
    //    보내기 시작하면 그때부터는 새 판정이 옳고 옛 판정이 틀린다(그것이 이 변경의 목적).
    const corpus = [
      '추가구성상품',
      '조합형옵션상품',
      '단일상품',
      '추가구성',
      '추가구성상품권',
      '',
    ];
    for (const value of corpus) {
      expect(value).toBe(value.normalize('NFC'));
      expect(isSupplementProduct({ productClass: value })).toBe(value === '추가구성상품');
    }
  });

  it('상수는 NFC 로 커밋돼 있다 — 소스가 NFD 로 저장되면 이 판정이 통째로 뒤집힌다', () => {
    expect(SUPPLEMENT_PRODUCT_CLASS).toBe(SUPPLEMENT_PRODUCT_CLASS.normalize('NFC'));
    expect(SUPPLEMENT_PRODUCT_CLASS.length).toBe(6);
  });
});
