import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '../../../test-utils'
import { AgentStudio } from '../AgentStudio'

describe('AgentStudio on Kimi', () => {
  it('keeps manual role creation but hides unsafe test/refine automation', () => {
    render(
      <AgentStudio
        provider="kimi"
        defaultModel="k3"
        automationEnabled={false}
        onClose={vi.fn()}
      />,
    )

    expect(screen.queryByRole('button', { name: /test agent/i })).not.toBeInTheDocument()
    expect(screen.getByPlaceholderText('custom-my-agent')).toBeInTheDocument()
    const editor = document.querySelector('textarea') as HTMLTextAreaElement
    expect(editor.value).toContain('model: k3')
    expect(editor.value).not.toContain('color:')
    expect(editor.value).not.toContain('memory:')
    expect(screen.getByText(/\.kimi-code\/skills\/custom-/)).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('custom-my-agent'), {
      target: { value: 'custom-kimi-reviewer' },
    })
    expect(editor.value).toContain('name: custom-kimi-reviewer')
    expect(screen.getByText('.kimi-code/skills/custom-kimi-reviewer/SKILL.md'))
      .toBeInTheDocument()
  })
})
