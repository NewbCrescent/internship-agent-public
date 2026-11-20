import { z } from "zod";

export const workspaceProfileSchema = z.enum(["real", "demo"]);

export type WorkspaceProfile = z.infer<typeof workspaceProfileSchema>;
