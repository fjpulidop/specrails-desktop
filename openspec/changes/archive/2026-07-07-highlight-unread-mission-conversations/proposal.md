# Highlight unread mission conversations

## Why
Agent conversations can continue receiving assistant output while the user is viewing another mission or while Specrails Desktop is backgrounded. The sidebar already signals live work with a title shimmer, but it does not identify which mission has unread assistant or system output that arrived out of view.

## What changes
- Add per-conversation unread state to the agent chat context and expose it as `unreadConversationIds`.
- Mark conversations unread when assistant/system output arrives while the conversation is inactive or the document is hidden.
- Clear unread state when the conversation successfully loads into view or when the document returns visible with that conversation already active.
- Render unread mission conversation icons with the theme destructive alert accent and a fast breathing glow, without removing the existing streaming title shimmer.
- Add tests for background unread activation, hidden-document activation, and clearing on selection/visibility return.

## Impact
- Affected specs: agent-mode-integrations
- Affected code: This touches the React client agent chat context, the Agent Mode left sidebar conversation row rendering, shared global CSS animation utilities, and the existing sidebar conversation test suite.
- Out of scope: No server-side unread persistence across restarts, OS notifications, sound, toast, notification center, unread counts, project folder icon changes, or removal of the existing live streaming title shimmer.
