export type ResumeActionState = { status: "idle" | "success" | "error"; message: string };

export const initialResumeActionState: ResumeActionState = { status: "idle", message: "" };
