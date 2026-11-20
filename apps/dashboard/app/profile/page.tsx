import { getCandidateWorkspace, getHandshakeSession, listBaseResumes, listCandidateDocuments } from "@internship-agent/agent";
import { resumeSourceSetting } from "@internship-agent/domain";

import { BaseResumePanel } from "@/components/profile/BaseResumePanel";
import { CandidateProfileForm } from "@/components/profile/CandidateProfileForm";
import { HandshakeConnectPanel } from "@/components/profile/HandshakeConnectPanel";
import { PreferenceForm } from "@/components/profile/PreferenceForm";
import { QuestionMemoryPanel } from "@/components/profile/QuestionMemoryPanel";
import { RememberedFacts } from "@/components/profile/RememberedFacts";
import { getActiveDatabase, getActiveProfile } from "@/lib/active-profile";

export const dynamic = "force-dynamic";

export default async function ProfilePage() {
  const [database, profile] = await Promise.all([getActiveDatabase(), getActiveProfile()]);
  const workspace = getCandidateWorkspace(database);
  const resumes = workspace.candidate ? listBaseResumes(database) : [];
  const documents = workspace.candidate ? listCandidateDocuments(database) : [];
  const handshakeSession = getHandshakeSession(database);

  return (
    <div className="page-stack">
      <header className="page-header compact-header">
        <div>
          <h1>Profile & memory</h1>
          <p>Preferences guide ranking; they never become application answers.</p>
        </div>
      </header>

      {!workspace.candidate ? (
        <div className="warning-banner">{profile === "real"
          ? "Enter your own details below to create the real profile. No demo facts are copied here."
          : <>Run <code>pnpm seed:dev</code> to create the fictional demo candidate.</>}</div>
      ) : null}

      <div className="two-column-grid">
        <CandidateProfileForm candidate={workspace.candidate} />
        <PreferenceForm preferences={workspace.preferences} />
      </div>

      {workspace.candidate ? (
        <div className="two-column-grid">
          <BaseResumePanel resumes={resumes} documents={documents} resumeSource={resumeSourceSetting()} />
          <HandshakeConnectPanel session={handshakeSession} />
        </div>
      ) : null}

      <QuestionMemoryPanel />
      <RememberedFacts facts={workspace.facts} />
    </div>
  );
}
