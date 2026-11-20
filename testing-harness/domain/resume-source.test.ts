import { describe, expect, it } from "vitest";

import { baseResumeChannelForProfile, resumeSourceSetting } from "@internship-agent/domain";

describe("resume source setting", () => {
  it("sends the candidate's uploaded resume unless the setting says generated", () => {
    expect(resumeSourceSetting({})).toBe("uploaded");
    expect(resumeSourceSetting({ INTERNSHIP_AGENT_RESUME_SOURCE: "generated" })).toBe("generated");
    expect(resumeSourceSetting({ INTERNSHIP_AGENT_RESUME_SOURCE: " Generated " })).toBe("generated");
    expect(resumeSourceSetting({ INTERNSHIP_AGENT_RESUME_SOURCE: "uploaded" })).toBe("uploaded");
    expect(resumeSourceSetting({ INTERNSHIP_AGENT_RESUME_SOURCE: "nonsense" })).toBe("uploaded");
  });

  it("maps each application profile to its base-resume channel", () => {
    expect(baseResumeChannelForProfile("default")).toBe("default");
    expect(baseResumeChannelForProfile("transcript")).toBe("handshake_internal");
  });
});
