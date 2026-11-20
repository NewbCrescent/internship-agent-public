import type { QuestionResolution } from "@internship-agent/domain";

export type FormActionState = { status: "idle" | "success" | "error"; message: string };
export type MemoryActionState = { resolution: QuestionResolution | null; error: string | null };

export const initialFormActionState: FormActionState = { status: "idle", message: "" };
export const initialMemoryActionState: MemoryActionState = { resolution: null, error: null };
