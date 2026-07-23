/**
 * The rendering for an `askUser` tool call: the agent's structured question as
 * a card of tappable options. Choosing one sends the option's label as the
 * user's next chat message — which is exactly what the tool's result told the
 * agent to wait for.
 */
import { useCallback } from 'react'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import type { AskUserInput } from '@/lib/ask-user'

function OptionButton({
  label,
  description,
  disabled,
  onPick,
}: {
  label: string
  description: string | undefined
  disabled: boolean
  onPick: (label: string) => void
}) {
  const handleClick = useCallback(() => {
    onPick(label)
  }, [onPick, label])

  return (
    <Button
      variant="outline"
      className="h-auto w-full flex-col items-start gap-0.5 px-3 py-2 text-left whitespace-normal"
      disabled={disabled}
      onClick={handleClick}
    >
      <span className="text-sm font-medium">{label}</span>
      {description !== undefined ? (
        <span className="text-xs font-normal text-muted-foreground">
          {description}
        </span>
      ) : null}
    </Button>
  )
}

export function QuestionCard({
  input,
  disabled,
  onPick,
}: {
  input: AskUserInput
  /** True while a run is streaming — a mid-run answer would be dropped. */
  disabled: boolean
  onPick: (label: string) => void
}) {
  return (
    <Bubble variant="outline">
      <BubbleContent className="flex w-full flex-col gap-2">
        <p className="text-sm font-medium">{input.question}</p>
        <div className="flex flex-col gap-1.5">
          {input.options.map((option) => (
            <OptionButton
              key={option.label}
              label={option.label}
              description={option.description}
              disabled={disabled}
              onPick={onPick}
            />
          ))}
        </div>
      </BubbleContent>
    </Bubble>
  )
}
