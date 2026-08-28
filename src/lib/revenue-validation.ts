/**
 * Revenue input validation utility.
 *
 * Validates raw user input strings for revenue/metrics fields.
 * Currency fields (actualSales, operatingExpense): 0–999,999,999, up to 2 decimal places.
 * Integer fields (quantity, itemCount): 0–999,999, no decimals.
 *
 * Returns a Korean error message string on failure, or null on success.
 */

const CURRENCY_MAX = 999_999_999;
const INTEGER_MAX = 999_999;

/**
 * Validates a revenue/metrics input field value.
 *
 * @param value - Raw user input string
 * @param fieldType - 'currency' for monetary fields, 'integer' for count fields
 * @returns Error message string if invalid, null if valid
 */
export function validateRevenueField(
  value: string,
  fieldType: "currency" | "integer",
): string | null {
  // Empty string is considered valid (nullable fields)
  if (value === "") {
    return null;
  }

  if (fieldType === "integer") {
    // Integer fields must not contain a decimal point
    if (value.includes(".")) {
      return "정수만 입력 가능합니다";
    }

    // Check for non-numeric characters (only digits allowed for integer)
    if (!/^\d+$/.test(value)) {
      return "숫자만 입력 가능합니다";
    }

    const num = Number(value);

    // Check for negative values
    if (num < 0) {
      return "0 이상의 값을 입력해주세요";
    }

    // Check max range
    if (num > INTEGER_MAX) {
      return `최대 ${INTEGER_MAX.toLocaleString()}까지 입력 가능합니다`;
    }

    return null;
  }

  // Currency field validation
  // Check for non-numeric characters (digits and single decimal point allowed)
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return "숫자만 입력 가능합니다";
  }

  // Check decimal places (max 2)
  const decimalIndex = value.indexOf(".");
  if (decimalIndex !== -1) {
    const decimalPlaces = value.length - decimalIndex - 1;
    if (decimalPlaces > 2) {
      return "소수점 이하 2자리까지 입력 가능합니다";
    }
  }

  const num = Number(value);

  // Check for negative values
  if (num < 0) {
    return "0 이상의 값을 입력해주세요";
  }

  // Check max range
  if (num > CURRENCY_MAX) {
    return `최대 ${CURRENCY_MAX.toLocaleString()}까지 입력 가능합니다`;
  }

  return null;
}
