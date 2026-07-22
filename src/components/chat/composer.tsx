/**
 * The composer — not shipped by the shadcn chat set, so it is ours:
 * `InputGroup` + `Textarea` + a send/stop button. Enter sends, Shift+Enter
 * breaks the line.
 */
import { useCallback, useState } from 'react'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'

export function Composer({
  onSend,
  onStop,
  isLoading,
}: {
  onSend: (text: string) => void
  onStop: () => void
  isLoading: boolean
}) {
  const [draft, setDraft] = useState('')

  const send = useCallback(() => {
    const text = draft.trim()
    if (text === '' || isLoading) return
    onSend(text)
    setDraft('')
  }, [draft, isLoading, onSend])

  const handleChange = useCallback(
    (event: { currentTarget: { value: string } }) => {
      setDraft(event.currentTarget.value)
    },
    [],
  )

  const handleKeyDown = useCallback(
    (event: {
      key: string
      shiftKey: boolean
      nativeEvent: { isComposing: boolean }
      preventDefault: () => void
    }) => {
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault()
        send()
      }
    },
    [send],
  )

  return (
    <InputGroup className="rounded-xl">
      <InputGroupTextarea
        placeholder="Describe the video to make…"
        value={draft}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={2}
        aria-label="Message"
      />
      <InputGroupAddon align="block-end" className="justify-end">
        {isLoading ? (
          <>
            <Spinner className="size-4" />
            <InputGroupButton
              size="icon-sm"
              variant="outline"
              onClick={onStop}
              aria-label="Stop the run"
            >
              <SquareIcon />
            </InputGroupButton>
          </>
        ) : (
          <InputGroupButton
            size="icon-sm"
            variant="default"
            onClick={send}
            disabled={draft.trim() === ''}
            aria-label="Send"
          >
            <ArrowUpIcon />
          </InputGroupButton>
        )}
      </InputGroupAddon>
    </InputGroup>
  )
}
