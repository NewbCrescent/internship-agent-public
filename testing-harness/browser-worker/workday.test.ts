import { describe, expect, it } from "vitest";

import { classifyWorkdayAccountMessage, markWorkdayResumeUpload, newWorkdayVerifyNotice, planAutofill, workdayErrorPauses, type WorkdayPageError } from "@internship-agent/browser";
import { browserSessionSchema, parseWorkdayUrl, workdaySiteKey, type RecognizedForm } from "@internship-agent/domain";

const FORM: RecognizedForm = {
  url: "https://fixture.wd1.myworkdayjobs.com/External/job/x/apply",
  title: "Apply",
  fields: [
    { id: "formField-legalName--firstName", label: "First Name", kind: "text", required: true },
    { id: "formField-phoneExtension", label: "Phone Extension", kind: "text", required: false },
    { id: "formField-phoneType", label: "Phone Device Type", kind: "select", required: true, options: ["Home", "Mobile"] },
    { id: "formField-phoneNumber", label: "Phone Number", kind: "tel", required: true }
  ]
};
const fieldError = (fieldId: string, label: string, text: string): WorkdayPageError => ({ fieldId, label, text, source: "field" });
const bannerError = (text: string): WorkdayPageError => ({ fieldId: null, label: null, text, source: "banner" });

describe("Workday career sites", () => {
  it("parses tenant, site, and job path with or without a locale", () => {
    expect(parseWorkdayUrl("https://philips.wd3.myworkdayjobs.com/en-US/jobs-and-careers/job/Cambridge/Intern_R123?utm_source=x"))
      .toEqual({ host: "philips.wd3.myworkdayjobs.com", tenant: "philips", site: "jobs-and-careers", jobPath: "Cambridge/Intern_R123" });
    expect(parseWorkdayUrl("https://ngc.wd1.myworkdayjobs.com/Northrop_Grumman_External_Site/job/US-VA/Intern_R1"))
      .toMatchObject({ site: "Northrop_Grumman_External_Site", jobPath: "US-VA/Intern_R1" });
    expect(parseWorkdayUrl("https://ngc.wd1.myworkdayjobs.com/en-US/External")).toMatchObject({ site: "External", jobPath: null });
    for (const url of ["https://ngc.wd1.myworkdayjobs.com.example.test/External/job/x", "http://ngc.wd1.myworkdayjobs.com/External/job/x",
      "https://jobs.lever.co/beacon/1", "not a url"]) expect(parseWorkdayUrl(url), url).toBeNull();
  });

  it("keys sessions per site and accepts only Handshake or Workday site keys", () => {
    const key = workdaySiteKey({ host: "ngc.wd1.myworkdayjobs.com", site: "External" });
    expect(key).toBe("workday:ngc.wd1.myworkdayjobs.com/External");
    const session = { status: "connected", detail: "Signed in.", checkedAt: "2026-09-24T00:00:00.000Z" };
    expect(browserSessionSchema.parse({ ...session, site: key }).site).toBe(key);
    expect(browserSessionSchema.parse({ ...session, site: "handshake" }).site).toBe("handshake");
    for (const site of ["workday:example.test/External", "lever", "workday:ngc.wd1.myworkdayjobs.com/"]) {
      expect(() => browserSessionSchema.parse({ ...session, site }), site).toThrow();
    }
  });

  it("reads Workday's account messages after a create or sign-in submit", () => {
    expect(classifyWorkdayAccountMessage("create", "An account already exists for this email address.")).toBe("exists");
    expect(classifyWorkdayAccountMessage("create", "Password must contain at least 8 characters and a special character.")).toBe("password-refused");
    expect(classifyWorkdayAccountMessage("create", "We sent an email to verify your account.")).toBe("verify-email");
    // The create form's own "Verify New Password" label is not a verification step.
    expect(classifyWorkdayAccountMessage("create", "Verify New Password")).toBeNull();
    expect(classifyWorkdayAccountMessage("create", "You must accept the terms and conditions.")).toBeNull();
    expect(classifyWorkdayAccountMessage("sign-in", "Wrong email address or password.")).toBe("wrong-password");
    expect(classifyWorkdayAccountMessage("sign-in", "The password you entered is incorrect.")).toBe("wrong-password");
    expect(classifyWorkdayAccountMessage("sign-in", "We couldn't find an account with that email.")).toBe("no-account");
    expect(classifyWorkdayAccountMessage("sign-in", "Your account is locked after too many failed attempts.")).toBe("locked");
    expect(classifyWorkdayAccountMessage("sign-in", "Please verify your account before signing in.")).toBe("verify-email");
    expect(classifyWorkdayAccountMessage("sign-in", "Please verify you are human.")).toBe("captcha");
    expect(classifyWorkdayAccountMessage("create", "I'm not a robot")).toBe("captcha");
    expect(classifyWorkdayAccountMessage("sign-in", "Enter website. This input is for robots only, do not enter if you're human.")).toBeNull();
    expect(classifyWorkdayAccountMessage("create", "Enter website. This input is for robots only, do not enter if you're human.")).toBeNull();
    expect(classifyWorkdayAccountMessage("sign-in", "Welcome back")).toBeNull();
    // Workday's generic sign-in failure only hedges a lock: a refused sign-in (11 tenants, 2026-11-25).
    expect(classifyWorkdayAccountMessage("sign-in", "You may have entered the wrong email address or password or your account might be locked.")).toBe("wrong-password");
    expect(classifyWorkdayAccountMessage("sign-in", "The email address or password you entered is incorrect, or your account may be locked.")).toBe("wrong-password");
    expect(classifyWorkdayAccountMessage("sign-in", "Your account might be locked, or you may have entered the wrong password.")).toBe("wrong-password");
    expect(classifyWorkdayAccountMessage("sign-in", "Your account has been locked.")).toBe("locked");
    expect(classifyWorkdayAccountMessage("sign-in", "Too many failed sign-in attempts. Try again later.")).toBe("locked");
    expect(classifyWorkdayAccountMessage("sign-in", "Your account has been temporarily disabled.")).toBe("locked");
    expect(classifyWorkdayAccountMessage("sign-in", "Your account has been locked. You may have entered the wrong email address or password or your account might be locked.")).toBe("locked");
    expect(classifyWorkdayAccountMessage("sign-in", "Your account may be locked.")).toBe("locked");
    expect(classifyWorkdayAccountMessage("sign-in", "Verify your account before you sign in or request a verification email.")).toBe("verify-email");
  });

  it("reads a not-verified account as the verification step, even when the message mentions the password", () => {
    expect(classifyWorkdayAccountMessage("sign-in", "Your account has not been verified. Verify your email, then sign in with your password.")).toBe("verify-email");
    expect(classifyWorkdayAccountMessage("create", "We sent an email to verify your account. Sign in with your password once it is verified.")).toBe("verify-email");
    expect(classifyWorkdayAccountMessage("sign-in", "Wrong email address or password.")).toBe("wrong-password");
    expect(classifyWorkdayAccountMessage("create", "Verify New Password")).toBeNull();
  });

  it("finds a verification notice that appeared after the submit, not one that was already there", () => {
    const form = "Sign In Email Address* Password* Sign In Create Account";
    const honeypot = "Enter website. This input is for robots only, do not enter if you're human.";
    const notice = "Your account has not been verified. Check your email for the verification link.";
    expect(newWorkdayVerifyNotice(form, `${form} ${notice}`)).toBe(true);
    expect(newWorkdayVerifyNotice(`${form} ${honeypot}`, `${form} ${honeypot} ${notice}`)).toBe(true);
    expect(newWorkdayVerifyNotice(`${form} ${notice}`, `${form} ${notice}`)).toBe(false);
    expect(newWorkdayVerifyNotice(form, `${form} ${honeypot}`)).toBe(false);
    expect(newWorkdayVerifyNotice("Create Account", "Email Address Password Verify New Password Create Account")).toBe(false);
  });

  it("turns each Workday error into its own pause, without the banner's duplicates", () => {
    const pauses = workdayErrorPauses("My Information", FORM, [
      fieldError("formField-phoneExtension", "Phone Extension", "The field Phone Extension is required and must have a value."),
      bannerError("Phone Extension: The field Phone Extension is required and must have a value.")
    ]);
    expect(pauses).toEqual([{
      fieldId: "workday-error::formField-phoneExtension",
      label: "Phone Extension: The field Phone Extension is required and must have a value.",
      question: "Phone Extension: The field Phone Extension is required and must have a value.",
      suggestedKey: null, suggestedScope: null, safeguard: false, sensitive: false, upload: false,
      status: "open", answer: null, draft: null, fieldKind: "text"
    }]);
  });

  it("attributes a banner error to the one field it names, and keeps the field's options", () => {
    const [pause, ...rest] = workdayErrorPauses("My Information", FORM, [bannerError("Phone Device Type: Select a value.")]);
    expect(rest).toEqual([]);
    expect(pause).toMatchObject({
      fieldId: "workday-error::formField-phoneType", label: "Phone Device Type: Select a value.", fieldKind: "select", options: ["Home", "Mobile"]
    });
  });

  it("leaves an error naming several fields unattributed", () => {
    const pauses = workdayErrorPauses("My Information", FORM, [bannerError("Phone Number and Phone Extension do not match.")]);
    expect(pauses).toEqual([expect.objectContaining({
      fieldId: "workday-error-1",
      label: "My Information: Phone Number and Phone Extension do not match.",
      question: "Workday could not save My Information: Phone Number and Phone Extension do not match.",
      safeguard: false, sensitive: false, upload: false
    })]);
    expect(pauses[0]).not.toHaveProperty("fieldKind");
  });

  it("labels an error on a field the form does not list with the page's label", () => {
    const pauses = workdayErrorPauses("My Experience", FORM, [
      fieldError("formField-jobTitle", "Job Title", "The field Job Title is required and must have a value."),
      { fieldId: null, label: null, text: "Something went wrong.", source: "page" }
    ]);
    expect(pauses.map((pause) => [pause.fieldId, pause.label, pause.question])).toEqual([
      ["workday-error-1", "Job Title: The field Job Title is required and must have a value.",
        "Workday could not save My Experience: Job Title: The field Job Title is required and must have a value."],
      ["workday-error-2", "My Experience: Something went wrong.", "Workday could not save My Experience: Something went wrong."]
    ]);
  });

  it("drops an unattributed error that repeats an attributed one, and caps the pauses at 10", () => {
    const repeated = workdayErrorPauses("My Information", FORM, [
      fieldError("formField-legalName--firstName", "First Name", "This field is required."),
      { fieldId: null, label: null, text: "this field is required.", source: "page" },
      bannerError("Errors found: this field is required.")
    ]);
    expect(repeated.map((pause) => pause.fieldId)).toEqual(["workday-error::formField-legalName--firstName"]);
    const many = workdayErrorPauses("My Information", FORM, Array.from({ length: 14 }, (_, index) => bannerError(`Unknown problem ${index + 1}.`)));
    expect(many).toHaveLength(10);
    expect(many.at(-1)?.fieldId).toBe("workday-error-10");
  });
});

describe("Workday's My Experience resume upload with a generic label (littelfuse.wd1, zoll.wd5, 2026-11-25)", () => {
  const upload = (id: string, label: string, required = true) => ({ id, label, kind: "file" as const, required });
  const form = (...fields: RecognizedForm["fields"]): RecognizedForm => ({ url: FORM.url, title: "Apply", fields });

  it("reads the one generic upload on My Experience as the resume upload, which receives the resume", () => {
    const marked = markWorkdayResumeUpload("My Experience", form(upload("formField-", "Upload a file (5MB max)")));
    expect(marked.fields[0]).toMatchObject({ id: "formField-", label: "Resume/CV", kind: "file", required: true });
    const plan = planAutofill(marked, { profile: {}, resolutions: new Map(), packageAnswers: [], variantId: "variant-1" });
    expect(plan.decisions[0]).toMatchObject({ fieldId: "formField-", action: "upload", basis: { kind: "variant", variantId: "variant-1" } });
    expect(plan.pauses).toEqual([]);
  });

  it("leaves other steps, two generic uploads, named documents, and an existing resume upload as read", () => {
    const generic = upload("formField-", "Upload a file (5MB max)");
    const other = form(generic);
    expect(markWorkdayResumeUpload("Application Questions", other)).toBe(other);
    const two = form(generic, upload("formField-other", "Upload files"));
    expect(markWorkdayResumeUpload("My Experience", two)).toBe(two);
    for (const label of ["Cover Letter", "Upload your transcript"]) {
      const named = form(upload("formField-", label));
      expect(markWorkdayResumeUpload("My Experience", named), label).toBe(named);
    }
    const withResume = form(upload("file-upload-input-ref", "Resume/CV", false), generic);
    expect(markWorkdayResumeUpload("My Experience", withResume)).toBe(withResume);
  });
});
