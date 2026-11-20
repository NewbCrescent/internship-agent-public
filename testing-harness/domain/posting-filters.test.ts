import { describe, expect, it } from "vitest";

import { countryName, NO_STATED_COUNTRY, parsePostingFilters, postingFilterParams } from "@internship-agent/domain";

describe("country and pay filters from the URL", () => {
  it("reads a country code, the not-stated value, and a minimum hourly pay", () => {
    expect(parsePostingFilters({ country: "us", minPay: "40" })).toEqual({ country: "US", minHourlyPay: 40 });
    expect(parsePostingFilters({ country: "none" })).toEqual({ country: NO_STATED_COUNTRY, minHourlyPay: null });
    expect(parsePostingFilters({ country: ["DE", "US"], minPay: ["22.50"] })).toEqual({ country: "DE", minHourlyPay: 22.5 });
  });

  it("treats anything malformed as no filter", () => {
    for (const country of ["USA", "U1", "", " ", "nonee", 7]) {
      expect(parsePostingFilters({ country }).country, String(country)).toBeNull();
    }
    for (const minPay of ["0", "-3", "abc", "1001", "12.345", "1e3", ""]) {
      expect(parsePostingFilters({ minPay }).minHourlyPay, minPay).toBeNull();
    }
  });

  it("writes back only the filters that are set", () => {
    expect(postingFilterParams({ country: "CA", minHourlyPay: 35 })).toEqual([["country", "CA"], ["minPay", "35"]]);
    expect(postingFilterParams({ country: null, minHourlyPay: null })).toEqual([]);
  });

  it("names countries for filter labels", () => {
    expect(countryName("SG")).toBe("Singapore");
    expect(countryName("GB")).toBe("United Kingdom");
  });
});
