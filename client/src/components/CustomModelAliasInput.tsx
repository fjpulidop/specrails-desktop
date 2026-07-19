import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import {
  CUSTOM_MODEL_ALIAS_MAX_LENGTH,
  isSafeCustomModelAlias,
} from '../lib/model-alias'
import { cn } from '../lib/utils'

export interface CustomModelAliasOption {
  value: string
  label: string
}

interface CustomModelAliasInputProps {
  value: string
  options: readonly CustomModelAliasOption[]
  onCommit: (value: string) => void
  disabled?: boolean
  ariaLabel: string
  testId?: string
  placeholder?: string
  className?: string
}

/**
 * Editable model picker for providers whose aliases are configured outside
 * SpecRails. Known models remain available through the native datalist while a
 * new, safe alias can be entered without SpecRails normalising or truncating it.
 */
export function CustomModelAliasInput({
  value,
  options,
  onCommit,
  disabled = false,
  ariaLabel,
  testId,
  placeholder,
  className,
}: CustomModelAliasInputProps) {
  const [draft, setDraft] = useState(value)
  const listId = useId()
  const restoreOnBlurRef = useRef(false)
  const valid = isSafeCustomModelAlias(draft)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const commitOrRestore = () => {
    if (restoreOnBlurRef.current) {
      restoreOnBlurRef.current = false
      setDraft(value)
      return
    }
    if (!valid) {
      setDraft(value)
      return
    }
    if (draft !== value) onCommit(draft)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      restoreOnBlurRef.current = true
      setDraft(value)
      event.currentTarget.blur()
    }
  }

  return (
    <>
      <input
        type="text"
        list={listId}
        value={draft}
        maxLength={CUSTOM_MODEL_ALIAS_MAX_LENGTH}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-invalid={!valid}
        data-testid={testId}
        placeholder={placeholder}
        className={cn(
          'rounded border border-border bg-transparent text-foreground outline-none',
          'focus:ring-1 focus:ring-accent-primary/40',
          !valid && 'border-destructive focus:ring-destructive/40',
          disabled && 'pointer-events-none opacity-50',
          className,
        )}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitOrRestore}
        onKeyDown={handleKeyDown}
      />
      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </datalist>
    </>
  )
}
