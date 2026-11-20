import { describe, expect, it } from "vitest";

import { classifyHandshakeUrl, isPdfBytes, shouldRunHeadless } from "@internship-agent/browser";

describe("Handshake session detection", () => {
  it("reads sign-in pages as signed out", () => {
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/login")).toBe("signed_out");
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/login?ref=apply")).toBe("signed_out");
    expect(classifyHandshakeUrl("https://berkeley.joinhandshake.com/users/sign_in")).toBe("signed_out");
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/sso/berkeley")).toBe("signed_out");
    // Observed live: a signed-out /login redirects here.
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/access")).toBe("signed_out");
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/access?redirect=%2Fexplore")).toBe("signed_out");
  });

  it("reads other app pages as connected", () => {
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/explore")).toBe("connected");
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/jobs/900001")).toBe("connected");
    expect(classifyHandshakeUrl("https://app.joinhandshake.com/loginfo")).toBe("connected");
  });

  it("never calls non-Handshake, marketing, or insecure pages connected", () => {
    expect(classifyHandshakeUrl("https://joinhandshake.com/")).toBe("other");
    expect(classifyHandshakeUrl("https://www.joinhandshake.com/students")).toBe("other");
    expect(classifyHandshakeUrl("https://auth.example.edu/cas/login")).toBe("other");
    expect(classifyHandshakeUrl("https://joinhandshake.com.evil.test/explore")).toBe("other");
    expect(classifyHandshakeUrl("http://app.joinhandshake.com/explore")).toBe("other");
    expect(classifyHandshakeUrl("not a url")).toBe("other");
  });
});

describe("browser launch and file checks", () => {
  it("opens a visible window unless HEADLESS=1 is set", () => {
    expect(shouldRunHeadless({})).toBe(false);
    expect(shouldRunHeadless({ HEADLESS: "0" })).toBe(false);
    expect(shouldRunHeadless({ HEADLESS: "1" })).toBe(true);
  });

  it("recognizes the PDF signature", () => {
    expect(isPdfBytes(new TextEncoder().encode("%PDF-1.7\n..."))).toBe(true);
    expect(isPdfBytes(new TextEncoder().encode("# Resume"))).toBe(false);
    expect(isPdfBytes(new Uint8Array())).toBe(false);
  });
});
