"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** A sidebar link that marks itself as the current page, including its nested routes. */
export function NavLink({ href, label }: { href: string; label: string }) {
  const pathname = usePathname();
  const current = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link href={href} className="nav-link" aria-current={current ? "page" : undefined}>
      {label}
    </Link>
  );
}
