import Link from "next/link";

export function ListPagination({ path, page, pageCount, total, pageSize = 50, status, sort, postedWithinDays, country, minHourlyPay, view }: {
  path: string; page: number; pageCount: number; total: number; pageSize?: number; status?: string; sort?: string; postedWithinDays?: number | null;
  country?: string | null; minHourlyPay?: number | null;
  /** Only the Review Queue's "all" view needs saying; focus is its default. */
  view?: string;
}) {
  const href = (next: number) => {
    const params = new URLSearchParams({ page: String(next) });
    if (status) params.set("status", status);
    if (sort) params.set("sort", sort);
    if (postedWithinDays != null) params.set("days", String(postedWithinDays));
    if (country) params.set("country", country);
    if (minHourlyPay != null) params.set("minPay", String(minHourlyPay));
    if (view === "all") params.set("view", view);
    return `${path}?${params}`;
  };
  return (
    <nav aria-label="List pagination" className="list-pagination">
      <p>{total === 0 ? "0 entries" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`} · Page {page} of {pageCount}</p>
      <div>
        {page > 1 ? <Link className="pill" href={href(page - 1)}>Previous page</Link> : null}
        {page < pageCount ? <Link className="pill" href={href(page + 1)}>Next page</Link> : null}
      </div>
    </nav>
  );
}
