import { describe, it, expect } from 'vitest'
import type { AgentConversation, MissionSearchHit } from '../agent-api'
import {
  foldText,
  groupOrderForMode,
  matchMissionTitles,
  matchesPaletteQuery,
  mergeMissionResults,
  recentMissions,
  RECENT_MISSIONS_MAX,
} from '../mission-search'

function conv(id: string, title: string | null, updatedAt: string, pinned: string | null = null): AgentConversation {
  return {
    id,
    title,
    provider: 'claude',
    model: null,
    session_id: null,
    pinned_project_id: pinned,
    tier_level: 0,
    reasoning_effort: null,
    created_at: updatedAt,
    updated_at: updatedAt,
  }
}

function hit(conversation: AgentConversation, match: 'title' | 'content', snippetText: string | null = null): MissionSearchHit {
  return {
    conversation,
    match,
    messageId: snippetText ? `m-${conversation.id}` : null,
    snippet: snippetText ? { text: snippetText, ranges: [[0, 3]] } : null,
  }
}

const older = conv('a', 'Tetris rewrite', '2026-09-01T10:00:00Z')
const newer = conv('b', 'Revisar la misión de deploy', '2026-09-05T10:00:00Z')
const untitled = conv('c', null, '2026-09-03T10:00:00Z')
const middle = conv('d', 'Analytics export', '2026-09-04T10:00:00Z')

describe('foldText', () => {
  it('lowercases and strips diacritics', () => {
    expect(foldText('MISIÓN déploy')).toBe('mision deploy')
  })
})

describe('matchesPaletteQuery', () => {
  it('matches everything on an empty query', () => {
    expect(matchesPaletteQuery('   ', 'Project Alpha')).toBe(true)
  })

  it('is a case- and diacritics-insensitive substring match over value and keywords', () => {
    expect(matchesPaletteQuery('BETA', 'Project Beta')).toBe(true)
    expect(matchesPaletteQuery('alpha', 'Project Beta', ['project-alpha'])).toBe(true)
    expect(matchesPaletteQuery('mision', 'Misión')).toBe(true)
    expect(matchesPaletteQuery('xyz', 'Project Beta', ['', 'other'])).toBe(false)
  })
})

describe('recentMissions', () => {
  it('returns the newest missions first, capped, as recent rows', () => {
    const rows = recentMissions([older, newer, untitled, middle], 3)
    expect(rows.map((r) => r.conversation.id)).toEqual(['b', 'd', 'c'])
    expect(rows.every((r) => r.match === 'recent' && r.snippet === null && r.messageId === null)).toBe(true)
    expect(RECENT_MISSIONS_MAX).toBe(8)
  })
})

describe('matchMissionTitles', () => {
  it('returns [] for an empty query', () => {
    expect(matchMissionTitles([older, newer], '  ', 'New mission')).toEqual([])
  })

  it('matches folded titles newest first and honours the cap', () => {
    const rows = matchMissionTitles([older, newer, middle], 'e', 'New mission', 2)
    expect(rows.map((r) => r.conversation.id)).toEqual(['b', 'd'])
    expect(rows[0].match).toBe('title')
    expect(matchMissionTitles([newer], 'MISION', 'New mission').map((r) => r.conversation.id)).toEqual(['b'])
    expect(matchMissionTitles([older], 'etris', 'New mission')).toHaveLength(1)
  })

  it('lets the untitled fallback label match untitled missions only', () => {
    expect(matchMissionTitles([untitled, older], 'new mission', 'New mission').map((r) => r.conversation.id)).toEqual(['c'])
  })
})

describe('mergeMissionResults', () => {
  it('keeps title rows first, enriches them with the server snippet, then appends server hits by kind', () => {
    const titleRows = matchMissionTitles([older], 'tetris', 'New mission')
    const serverTitleOnly = conv('e', 'Old tetris thread', '2026-08-01T10:00:00Z')
    const serverContent = conv('f', 'Unrelated', '2026-08-02T10:00:00Z')
    const rows = mergeMissionResults(titleRows, [
      hit(serverContent, 'content', 'tetris board is 10 by 20'),
      hit(older, 'title', 'the tetris score resets'),
      hit(serverTitleOnly, 'title'),
    ])
    expect(rows.map((r) => [r.conversation.id, r.match])).toEqual([
      ['a', 'title'],
      ['e', 'title'],
      ['f', 'content'],
    ])
    expect(rows[0].snippet?.text).toBe('the tetris score resets')
    expect(rows[0].messageId).toBe('m-a')
    expect(rows[2].snippet?.ranges).toEqual([[0, 3]])
  })

  it('never duplicates a mission and respects the cap', () => {
    const titleRows = matchMissionTitles([older], 'tetris', 'New mission')
    const rows = mergeMissionResults(titleRows, [hit(older, 'content', 'x'), hit(older, 'title'), hit(middle, 'content', 'y')], 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].conversation.id).toBe('a')
  })

  it('returns only server hits when nothing matched by title locally', () => {
    const rows = mergeMissionResults([], [hit(middle, 'content', 'export csv')])
    expect(rows.map((r) => r.conversation.id)).toEqual(['d'])
  })
})

describe('groupOrderForMode', () => {
  it('leads with missions in agent mode and with projects on the board', () => {
    expect(groupOrderForMode('agent')).toEqual(['missions', 'projects', 'spec', 'jobs', 'navigation'])
    expect(groupOrderForMode('kanban')).toEqual(['projects', 'missions', 'spec', 'jobs', 'navigation'])
  })
})
