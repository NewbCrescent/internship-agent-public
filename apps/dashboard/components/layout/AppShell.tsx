import { Suspense, type ReactNode } from "react";

import { NavLink } from "@/components/layout/NavLink";
import { switchProfileAction } from "@/app/profile/switch-action";
import { getActiveProfile } from "@/lib/active-profile";

const navigation = [
  { href: "/", label: "Overview", active: true },
  { href: "/profile", label: "Profile & Memory", active: true },
  { href: "/resume", label: "Resume", active: true },
  { href: "/jobs", label: "Jobs", active: true },
  { href: "/review", label: "Review Queue", active: true },
  { href: "/applications", label: "Applications", active: true },
  { href: "/workday", label: "Workday accounts", active: true },
  { href: "/evidence", label: "Evidence", active: true }
];

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <span className="brand-mark">IA</span>
          <div>
            <strong>Internship Agent</strong>
            <span>Local workspace</span>
          </div>
        </div>
        <Suspense fallback={<p className="profile-switch">Loading profile…</p>}>
          <ProfileSwitch />
        </Suspense>
        <nav aria-label="Primary navigation">
          {navigation.map((item) => item.active ? (
            <NavLink href={item.href} key={item.label} label={item.label} />
          ) : (
            <span className="nav-link nav-link-disabled" key={item.label} aria-disabled="true">
              {item.label}<small>Later</small>
            </span>
          ))}
        </nav>
        <div className="privacy-note">
          <span className="status-dot" />
          Local-only data
        </div>
      </aside>
      <main className="main-content">{children}</main>
    </div>
  );
}

async function ProfileSwitch() {
  const activeProfile = await getActiveProfile();
  return (
    <form action={switchProfileAction} className="profile-switch" aria-label="Active profile">
      <span>Current profile: {activeProfile === "real" ? "Real" : "Demo"}</span>
      <div>
        <button type="submit" name="profile" value="real" aria-pressed={activeProfile === "real"}>Real</button>
        <button type="submit" name="profile" value="demo" aria-pressed={activeProfile === "demo"}>Demo</button>
      </div>
    </form>
  );
}
