"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Near-live progress without new infrastructure: refresh server data on an interval. */
export function AutoRefresh({ intervalMs = 15000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [router, intervalMs]);
  return null;
}
