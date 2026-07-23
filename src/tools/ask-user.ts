/**
 * `askUser` — structured questions as UI, not prose.
 *
 * The /hyperframes skill runs an intent interview, and in a chat that used to
 * mean paragraphs of numbered options. This tool turns one question into a
 * card of tappable options in the studio (see
 * src/components/chat/question-card.tsx). The tool itself does nothing on the
 * host — its result exists to tell the agent the question is on screen and
 * that the answer arrives as the user's NEXT message, so it must end its turn.
 */
import { toolDefinition } from '@tanstack/ai'
import { askUserInputSchema } from '../lib/ask-user'

export function askUserTool() {
  return toolDefinition({
    name: 'askUser',
    description:
      'Present ONE multiple-choice question to the user as tappable options in the studio UI. Use it whenever the user must choose — intent-interview questions, style directions, approve-before-render. Ask exactly one question per turn, then END YOUR TURN: the answer arrives as the next user message. Prefer this over prose lists of options.',
    inputSchema: askUserInputSchema,
  }).server(() => ({
    ok: true as const,
    note: 'Question presented with tappable options. End your turn now; the answer arrives as the next user message.',
  }))
}
