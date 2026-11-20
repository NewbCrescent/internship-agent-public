import { z } from "zod";

export const outcomeStageSchema = z.enum([
  "RESPONSE", "OA", "SCREEN", "INTERVIEW", "FINAL", "OFFER", "REJECTED", "GHOSTED"
]);

export const outcomeEventSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  stage: outcomeStageSchema,
  note: z.string().max(500).nullable(),
  recordedAt: z.iso.datetime()
});

export type OutcomeStage = z.infer<typeof outcomeStageSchema>;
export type OutcomeEvent = z.infer<typeof outcomeEventSchema>;
