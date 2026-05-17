import { z } from "zod";

export const provisionRequestSchema = z.object({
  mapsUrl: z
    .string()
    .min(1, "mapsUrl is required")
    .refine(
      (s) => s.includes("google.com/maps") || s.includes("maps.app.goo.gl") || s.includes("goo.gl/maps"),
      "Must be a Google Maps URL",
    ),
});

export type ProvisionRequest = z.infer<typeof provisionRequestSchema>;
