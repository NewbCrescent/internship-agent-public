export type JobActionState = { status: "idle" | "success" | "error"; message: string };

export const initialJobActionState: JobActionState = { status: "idle", message: "" };
