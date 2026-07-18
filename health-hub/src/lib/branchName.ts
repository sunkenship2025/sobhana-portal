/**
 * Strip the clinic prefix from a branch's stored name for compact UI display.
 * "Sobhana - Balanagar" -> "Balanagar", "Sobhana – Chintal" -> "Chintal".
 * Names without a " - "/" – "/" — " separator are returned unchanged, so this
 * is safe for any tenant (only the leading "<clinic> - " segment is dropped).
 */
export function branchShortName(name?: string | null): string {
  if (!name) return "";
  const parts = name.split(/\s+[-–—]\s+/);
  return (parts.length > 1 ? parts.slice(1).join(" - ") : name).trim();
}
