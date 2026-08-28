/**
 * Campaign name auto-generation utility.
 *
 * Pure function for generating campaign names from deal name, seller name,
 * and optional round number.
 */

/**
 * Generates a campaign name from the given deal name, seller name, and optional round number.
 *
 * Format: "{dealName} {sellerName} {N}차" (with round) or "{dealName} {sellerName}" (without round)
 * Truncates at 100 characters.
 * Returns null if dealName or sellerName is null or empty.
 *
 * @param dealName - The deal name
 * @param sellerName - The seller name
 * @param roundNumber - The round number (optional)
 * @returns The generated campaign name, or null if inputs are insufficient
 */
export function generateCampaignName(
  dealName: string | null,
  sellerName: string | null,
  roundNumber: number | null,
): string | null {
  if (!dealName || !sellerName) {
    return null;
  }

  const name =
    roundNumber != null
      ? `${dealName} - ${sellerName} ${roundNumber}차`
      : `${dealName} - ${sellerName}`;

  return name.slice(0, 100);
}
