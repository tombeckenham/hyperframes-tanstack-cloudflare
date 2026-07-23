/**
 * The composer — not shipped by the shadcn chat set, so it is ours:
 * `InputGroup` + `Textarea` + a send/stop button. Enter sends, Shift+Enter
 * breaks the line.
 *
 * Typing `/` at the start opens a slash-command menu (the skills baked into
 * the sandbox image — see slash-commands.ts). Hand-rolled rather than built on
 * the registry's `command` (cmdk): cmdk owns its own input and keyboard
 * bindings, and this menu must be driven by the textarea's.
 */
import { useCallback, useEffect, useState } from 'react'
import { ArrowUpIcon, SquareIcon } from 'lucide-react'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { SLASH_COMMANDS } from './slash-commands'
import type { SlashCommand } from './slash-commands'

const NO_MATCHES: ReadonlyArray<SlashCommand> = []

function SlashItem({
  command,
  index,
  active,
  onHover,
  onPick,
}: {
  command: SlashCommand
  index: number
  active: boolean
  onHover: (index: number) => void
  onPick: (name: string) => void
}) {
  const handleHover = useCallback(() => {
    onHover(index)
  }, [onHover, index])
  const handlePick = useCallback(() => {
    onPick(command.name)
  }, [onPick, command.name])

  return (
    <button
      type="button"
      // Keep focus in the textarea; the click still fires.
      onMouseDown={preventDefault}
      onMouseEnter={handleHover}
      onClick={handlePick}
      className={`flex w-full items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
        active ? 'bg-accent text-accent-foreground' : ''
      }`}
    >
      <span className="font-mono font-medium">/{command.name}</span>
      <span className="truncate text-xs text-muted-foreground">
        {command.description}
      </span>
    </button>
  )
}

function preventDefault(event: { preventDefault: () => void }): void {
  event.preventDefault()
}

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
  const [highlight, setHighlight] = useState(0)
  const [dismissed, setDismissed] = useState(false)

  // The menu is open while the draft is exactly a slash-prefix: "/hy", not
  // "/hyperframes make me…" — the first space closes it.
  const slashQuery =
    !dismissed && draft.startsWith('/') && !/\s/u.test(draft)
      ? draft.slice(1).toLowerCase()
      : null
  const matches =
    slashQuery === null
      ? NO_MATCHES
      : SLASH_COMMANDS.filter((c) => c.name.startsWith(slashQuery))
  const menuOpen = matches.length > 0

  useEffect(() => {
    setHighlight(0)
  }, [slashQuery])

  const send = useCallback(() => {
    const text = draft.trim()
    if (text === '' || isLoading) return
    onSend(text)
    setDraft('')
  }, [draft, isLoading, onSend])

  const accept = useCallback((name: string) => {
    setDraft(`/${name} `)
    setDismissed(false)
  }, [])

  const handleChange = useCallback(
    (event: { currentTarget: { value: string } }) => {
      setDraft(event.currentTarget.value)
      setDismissed(false)
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
      if (menuOpen) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setHighlight((h) => (h + 1) % matches.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setHighlight((h) => (h + matches.length - 1) % matches.length)
          return
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          event.preventDefault()
          const chosen = matches[highlight] ?? matches[0]
          if (chosen !== undefined) accept(chosen.name)
          return
        }
        if (event.key === 'Escape') {
          setDismissed(true)
          return
        }
      }
      if (
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.nativeEvent.isComposing
      ) {
        event.preventDefault()
        send()
      }
    },
    [menuOpen, matches, highlight, accept, send],
  )

  return (
    <div className="relative">
      {menuOpen ? (
        <div className="absolute bottom-full left-0 z-10 mb-2 w-full overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-md">
          {matches.map((command, index) => (
            <SlashItem
              key={command.name}
              command={command}
              index={index}
              active={index === highlight}
              onHover={setHighlight}
              onPick={accept}
            />
          ))}
        </div>
      ) : null}
      <InputGroup className="rounded-xl">
        <InputGroupTextarea
          placeholder="Describe the video to make… (/ for commands)"
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
    </div>
  )
}
