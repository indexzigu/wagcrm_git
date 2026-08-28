type ProductMappingLike = {
  id?: string | null;
  productName?: string | null;
  optionName?: string | null;
  brandCode?: string | null;
};

const compareText = (a?: string | null, b?: string | null) =>
  (a ?? '').trim().localeCompare((b ?? '').trim(), 'ko-KR', {
    numeric: true,
    sensitivity: 'base',
  });

export function sortProductMappingsByProductName<T extends ProductMappingLike>(mappings: readonly T[]): T[] {
  return mappings
    .map((mapping, index) => ({ mapping, index }))
    .sort((a, b) => {
      const aHasProductName = Boolean(a.mapping.productName?.trim());
      const bHasProductName = Boolean(b.mapping.productName?.trim());
      if (aHasProductName !== bHasProductName) return aHasProductName ? -1 : 1;

      return (
        compareText(a.mapping.productName, b.mapping.productName) ||
        compareText(a.mapping.optionName, b.mapping.optionName) ||
        compareText(a.mapping.brandCode, b.mapping.brandCode) ||
        compareText(a.mapping.id, b.mapping.id) ||
        a.index - b.index
      );
    })
    .map(({ mapping }) => mapping);
}
