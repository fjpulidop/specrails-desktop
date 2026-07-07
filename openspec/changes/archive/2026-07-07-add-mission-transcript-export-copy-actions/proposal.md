# Add mission transcript export and copy actions

## Why
Users can review a mission inside Specrails, but there is no direct way to take the full chat transcript out of the app. Sharing, archiving, or pasting a mission currently requires manually selecting individual messages, which is slow and easy to get wrong.

## What changes
- Add copy-all and plain-text export actions to the active mission title overflow menu in Agent Mode.
- Build a plain-text transcript from the active mission, loaded messages, and pinned project metadata.
- Include mission title, mission id, project name/path when available, export timestamp, and chronological message entries with role labels, timestamps, and multiline content.
- Add localized menu labels and success/failure toast strings to every `agent.json` locale.
- Cover transcript formatting plus the copy-all and export actions in client tests.

## Impact
- Affected specs: agent-mode-integrations
- Affected code: The change is contained to the Agent Mode conversation header UI, its colocated component tests, and the `agent` i18n namespace files for English, Spanish, French, German, Portuguese, Italian, Chinese, and Japanese. It reuses the existing clipboard/toast pattern in `AgentConversationHeader.tsx` and the client-side Blob/object-URL download pattern demonstrated in `ExportDropdown.tsx`.
- Out of scope: No server-side export endpoint or persistent exported file management; no Markdown, JSON, PDF, DOCX, or rich-text export format; no export controls in the floating Board-mode `AgentMissionSelector` dropdown; no inclusion of binary attachments beyond existing message/context text references; no changes to mission deletion, rename, favorite, or existing copy metadata actions.
