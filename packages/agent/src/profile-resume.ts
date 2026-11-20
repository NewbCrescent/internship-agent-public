import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  closeProfileDatabase,
  getCurrentBaseResume,
  getProfileDatabase,
  LOCAL_CANDIDATE_ID,
  resolveProfileDataDirectory
} from "@internship-agent/db";
import { baseResumeFilePath, readablePdfPages } from "@internship-agent/browser";
import {
  baseResumeChannelSchema,
  resumeSourceSetting,
  workspaceProfileSchema,
  type BaseResumeChannel,
  type WorkspaceProfile
} from "@internship-agent/domain";

import { assertStorablePdf, storeBaseResume } from "./base-resume-service";
import { acquirePipelineLock } from "./pipeline-lock";

/**
 * `pnpm profile:resume`: lists or stores the candidate's uploaded resumes
 * (`default` for default-profile applications, `handshake_internal` for the
 * 2029 profile). Applications send the current upload byte for byte, so
 * storing takes the pipeline lock and the file is copied unchanged. A PDF
 * that is not one page is stored with a warning.
 */
export type ProfileResumeDeps = {
  open(profile: WorkspaceProfile): DatabaseSync;
  close(profile: WorkspaceProfile): void;
  dataDir(profile: WorkspaceProfile): string;
  readFile(path: string): Uint8Array;
  lock(dataDir: string): () => void;
  log(line: string): void;
};

const USAGE = "Usage: pnpm profile:resume --profile real|demo [--channel default|handshake_internal --file <pdf> [--label <text>] [--dry-run]]";

const CHANNELS: readonly BaseResumeChannel[] = ["default", "handshake_internal"];

type ParsedArgs = {
  profile: WorkspaceProfile;
  store: { channel: BaseResumeChannel; file: string; label: string | null; dryRun: boolean } | null;
};

function parseArgs(argv: string[]): ParsedArgs | null {
  let profile: string | null = null;
  let channel: string | null = null;
  let file: string | null = null;
  let label: string | null = null;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") profile = argv[++index] ?? null;
    else if (arg === "--channel") {
      channel = argv[++index] ?? null;
      if (!channel) return null;
    } else if (arg === "--file") {
      file = argv[++index] ?? null;
      if (!file) return null;
    } else if (arg === "--label") {
      label = argv[++index] ?? null;
      if (label === null) return null;
    } else if (arg === "--dry-run") dryRun = true;
    else return null;
  }
  const parsedProfile = workspaceProfileSchema.safeParse(profile);
  if (!parsedProfile.success) return null;
  if ((channel === null) !== (file === null)) return null;
  if (file === null) {
    if (label !== null || dryRun) return null;
    return { profile: parsedProfile.data, store: null };
  }
  const parsedChannel = baseResumeChannelSchema.safeParse(channel);
  if (!parsedChannel.success) return null;
  const trimmed = label?.trim() ?? null;
  if (trimmed !== null && trimmed.length > 120) return null;
  return { profile: parsedProfile.data, store: { channel: parsedChannel.data, file, label: trimmed || null, dryRun } };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function kilobytes(size: number): string {
  return `${(size / 1024).toFixed(1)} KB`;
}

function pageText(pages: number | null): string {
  return pages === null ? "pages unreadable" : `${pages} page${pages === 1 ? "" : "s"}`;
}

function pageWarning(pages: number | null): string | null {
  if (pages === null) return "warning: the page count could not be read (the PDF may be encrypted); check that it is one page.";
  if (pages !== 1) return `warning: this PDF has ${pages} pages; applications expect a one-page resume.`;
  return null;
}

async function listUploads(database: DatabaseSync, dataDir: string, io: ProfileResumeDeps): Promise<void> {
  for (const channel of CHANNELS) {
    const resume = getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, channel);
    if (!resume) {
      io.log(`${channel}: none`);
      continue;
    }
    const named = `${channel} "${resume.label}" (originally ${resume.originalName})`;
    const path = baseResumeFilePath(dataDir, resume.fileName);
    if (!existsSync(path)) {
      io.log(`${named}: file missing; upload it again`);
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      io.log(`${named}: file missing; upload it again`);
      continue;
    }
    if (sha256(bytes) !== resume.sha256) {
      io.log(`${named}: file changed on disk; upload it again`);
      continue;
    }
    const pages = await readablePdfPages(bytes);
    io.log(`${named}: ${pageText(pages)}, ${kilobytes(bytes.length)}, sha256 ${resume.sha256}, stored ${resume.createdAt}`);
  }
  if (resumeSourceSetting() === "generated") {
    io.log("INTERNSHIP_AGENT_RESUME_SOURCE=generated: applications send the tailored resume, not these uploads.");
  }
}

export async function runProfileResume(argv: string[], deps: Partial<ProfileResumeDeps> = {}): Promise<number> {
  const io: ProfileResumeDeps = {
    open: deps.open ?? getProfileDatabase,
    close: deps.close ?? closeProfileDatabase,
    dataDir: deps.dataDir ?? resolveProfileDataDirectory,
    readFile: deps.readFile ?? ((path) => new Uint8Array(readFileSync(path))),
    lock: deps.lock ?? ((dataDir) => acquirePipelineLock(dataDir)),
    log: deps.log ?? ((line) => console.log(line))
  };
  const args = parseArgs(argv);
  if (!args) {
    io.log(USAGE);
    return 2;
  }

  let bytes: Uint8Array | null = null;
  if (args.store) {
    try {
      bytes = io.readFile(args.store.file);
    } catch {
      io.log("The PDF could not be read.");
      return 1;
    }
    try {
      assertStorablePdf(bytes, "Base resumes");
    } catch (error) {
      io.log(error instanceof Error ? error.message : "The file could not be stored.");
      return 1;
    }
  }

  const database = io.open(args.profile);
  try {
    const dataDir = io.dataDir(args.profile);
    if (!args.store || !bytes) {
      await listUploads(database, dataDir, io);
      return 0;
    }
    const { channel, file, label, dryRun } = args.store;
    const hash = sha256(bytes);
    const pages = await readablePdfPages(bytes);
    const warning = pageWarning(pages);
    const originalName = basename(file);
    const current = getCurrentBaseResume(database, LOCAL_CANDIDATE_ID, channel);
    if (current && current.sha256 === hash) {
      io.log(`unchanged ${channel} "${current.label}": already the current upload (sha256 ${hash})`);
      return 0;
    }
    if (dryRun) {
      const shownLabel = label ?? (channel === "handshake_internal" ? "Handshake resume" : "Default resume");
      io.log(`would store ${channel} "${shownLabel}" (originally ${originalName}): ${pageText(pages)}, ${kilobytes(bytes.length)}, sha256 ${hash}`);
      if (warning) io.log(warning);
      return 0;
    }
    let release: () => void;
    try {
      release = io.lock(dataDir);
    } catch (error) {
      io.log(`Not stored: ${error instanceof Error ? error.message : "the pipeline lock could not be taken."}`);
      return 1;
    }
    try {
      const saved = storeBaseResume({ channel, label: label ?? "", originalName, bytes }, { database, dataDir });
      io.log(`stored ${channel} "${saved.label}" (originally ${saved.originalName}): ${pageText(pages)}, ${kilobytes(saved.byteSize)}, sha256 ${saved.sha256}`);
      if (current) io.log(`superseded ${channel} "${current.label}" (sha256 ${current.sha256.slice(0, 12)}…)`);
      if (warning) io.log(warning);
      return 0;
    } catch (error) {
      io.log(error instanceof Error ? error.message : "The file could not be stored.");
      return 1;
    } finally {
      release();
    }
  } finally {
    io.close(args.profile);
  }
}
