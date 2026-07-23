/**
 * The `askUser` question payload — shared between the host tool (which
 * validates what the agent sends) and the chat UI (which re-parses the
 * tool-call arguments off the stream to render tappable options). One schema,
 * two ends of the wire, per the repo's validate-at-the-boundary convention.
 */
import { z } from 'zod'

export const askUserInputSchema = z.object({
  question: z.string().min(1).max(500),
  options: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        description: z.string().max(200).optional(),
      }),
    )
    .min(2)
    .max(6),
})

export type AskUserInput = z.infer<typeof askUserInputSchema>

/** Parse a tool-call part's raw `arguments` JSON. Null on anything malformed. */
export function parseAskUserArguments(raw: string): AskUserInput | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = askUserInputSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
