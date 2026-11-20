/** Validated page numbers and bounded offsets shared by local dashboard lists. */
export function listPageBounds(total: number, input: unknown, pageSize = 50) {
  const parsed = typeof input === "number" ? input : typeof input === "string" && /^\d+$/.test(input) ? Number(input) : 1;
  const requested = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requested, pageCount);
  return { total, page, pageCount, pageSize, offset: (page - 1) * pageSize };
}
