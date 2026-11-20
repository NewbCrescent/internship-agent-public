export type WorkdayActionState = { status: "idle" | "success" | "error"; message: string };
export const initialWorkdayActionState: WorkdayActionState = { status: "idle", message: "" };
