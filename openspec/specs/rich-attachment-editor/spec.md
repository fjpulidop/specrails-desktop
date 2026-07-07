# rich-attachment-editor Specification

## Purpose
Define rich attachment editor content, paste, undo, drag-and-drop, file browser, and image paste behavior.

## Requirements

### Requirement: RichAttachmentEditor renders as contenteditable with inline pills
The system SHALL render a `contenteditable` div that accepts plain text input and displays attached files as inline non-editable `@filename` pill spans. The component SHALL expose a `getPlainText(): string` method that serializes content as plain text with `@[<filename>](<attachmentId>)` tokens in place of pills. The component SHALL also expose `getAttachmentIds(): string[]` returning the ordered list of attachment ids currently referenced by pills, which the parent form submits alongside the plain text.

#### Scenario: Typing plain text
- **WHEN** the user types in the editor
- **THEN** text appears as-is with no transformation

#### Scenario: Attachment pill inserted
- **WHEN** an attachment is added
- **THEN** `@<filename>` appears as a styled inline pill at the current cursor position
- **AND** the pill span has `contenteditable="false"` so it cannot be partially edited
- **AND** the pill span carries `data-attachment-id="<uuid>"` and `data-filename="<filename>"`

#### Scenario: Plain text serialization
- **WHEN** `getPlainText()` is called
- **THEN** all text nodes are returned as-is and all pill spans are replaced with `@[<filename>](<attachmentId>)` tokens
- **AND** two pills referencing different files that share a filename are distinguishable by their attachmentId in the serialized output

### Requirement: Paste sanitization and IME safety
The system SHALL strip formatting on paste and SHALL NOT mutate editor content during IME composition. All paste operations insert plain text only (`clipboardData.getData('text/plain')`); no HTML/RTF is ever injected into the DOM. Pill insertion via paste/drop/browser is deferred until after `compositionend` when composition is active.

#### Scenario: User pastes rich text from another app
- **WHEN** the user pastes formatted text (e.g. from a web page with tags, styles, images)
- **THEN** only the plain text representation is inserted
- **AND** no `<img>`, `<style>`, `<script>`, or inline formatting survives

#### Scenario: Pill insertion during IME composition
- **WHEN** a file is dropped while the user is mid-composition (e.g. Japanese/Chinese input)
- **THEN** pill insertion waits for `compositionend` before modifying the DOM
- **AND** the composed text is not corrupted

### Requirement: Custom undo/redo stack for pill operations
The system SHALL maintain an internal command stack for `insertPill`, `removePill`, and `insertText` operations so that Cmd+Z / Ctrl+Z undoes pill insertion/removal consistently across browsers, independently of the native contenteditable undo stack.

#### Scenario: Undo pill insertion
- **WHEN** the user inserts a pill and then presses Cmd+Z
- **THEN** the pill is removed from the editor
- **AND** the associated chip remains (file stays on server; only the text reference is undone)

#### Scenario: Redo after undo
- **WHEN** the user undoes then redoes with Cmd+Shift+Z
- **THEN** the pill is reinserted at its original position

### Requirement: Drag & drop onto modal triggers full-screen overlay
The system SHALL detect `dragenter` on the modal's root element and render a full-overlay drop zone with a pulsing border animation and "Drop to add context" label. Releasing files over the overlay SHALL upload them and insert pills at the editor's last known cursor position.

#### Scenario: File dragged over modal
- **WHEN** the user drags a file over anywhere on the ProposeSpecModal or TicketDetailModal
- **THEN** a full-overlay drop zone appears over the modal content with a pulsing animated border

#### Scenario: File dropped on overlay
- **WHEN** the user releases supported files onto the overlay
- **THEN** the overlay dismisses, each file is uploaded, and pills are inserted into the editor
- **AND** unsupported file types show an inline error toast listing the rejected files

#### Scenario: Drag leaves modal without drop
- **WHEN** the user drags a file out of the modal without dropping
- **THEN** the overlay dismisses with no file uploaded

### Requirement: File browser supports multi-select
The system SHALL render a "Browse files" button inside the editor's attachment zone that opens the native file picker with `multiple` attribute set and `accept` limited to supported types. All selected files SHALL be uploaded in parallel and pills inserted in filename order.

#### Scenario: User selects multiple files
- **WHEN** the user opens the file browser and selects 3 files
- **THEN** all 3 files are uploaded in parallel
- **AND** 3 pills are inserted into the editor in the order the files were selected
- **AND** chips appear with a staggered entry animation (50ms delay between each)

#### Scenario: User selects a single file
- **WHEN** the user selects one file via the browser
- **THEN** one pill is inserted and one chip appears

### Requirement: Paste detection for images
The system SHALL intercept `paste` events on the editor. When the clipboard contains image data (e.g. a screenshot copied from the OS), it SHALL convert it to a File object named `paste-<YYYY-MM-DD>-<counter>.png`, upload it, and insert a pill.

#### Scenario: User pastes a screenshot
- **WHEN** the user presses Cmd+V / Ctrl+V and the clipboard contains image data
- **THEN** the image is captured as a PNG file, uploaded, and its pill inserted at cursor
- **AND** the default paste behavior (inserting raw data) is prevented

#### Scenario: User pastes plain text
- **WHEN** the user pastes plain text
- **THEN** the text is inserted normally with no interception

### Requirement: Attachment chips display rich metadata
The system SHALL render each attached file as a card chip below the editor with a type-appropriate icon, the filename, a size or metadata subtitle, and a remove button. Chips SHALL animate in with `scale(0.8) → scale(1)` + fade, staggered 50ms per chip. Removal SHALL animate with `scale(1) → scale(0)` + width collapse before unmounting.

#### Scenario: Image chip
- **WHEN** an image file is attached
- **THEN** its chip shows a thumbnail preview, the filename, and image dimensions

#### Scenario: PDF chip
- **WHEN** a PDF is attached
- **THEN** its chip shows a PDF icon, the filename, and the extracted page count (if available)

#### Scenario: CSV / Excel chip
- **WHEN** a CSV or Excel file is attached
- **THEN** its chip shows a table icon, the filename, and the row count

#### Scenario: JSON / TXT chip
- **WHEN** a JSON or TXT file is attached
- **THEN** its chip shows a code/document icon, the filename, and file size in KB

#### Scenario: Upload in progress
- **WHEN** a file is being uploaded
- **THEN** its chip shows a progress indicator and is non-interactive until upload completes

### Requirement: Removing an attachment is bidirectionally coherent
The system SHALL ensure that removing a file via its chip remove button OR via keyboard-deleting its `@pill` in the editor results in: the file deleted from the server (DELETE endpoint called), the pill removed from editor content, and the chip removed from the chip list.

#### Scenario: User clicks chip remove button
- **WHEN** the user clicks ✕ on a chip
- **THEN** the chip animates out, the corresponding `@pill` is removed from editor content, and the file is deleted from the server

#### Scenario: User keyboard-deletes a pill
- **WHEN** the cursor is adjacent to an `@pill` and the user presses Backspace or Delete
- **THEN** the pill is removed from editor content, the chip animates out, and the file is deleted from the server

### Requirement: Resources section on TicketDetailModal
The system SHALL render an `AttachmentsSection` below the AI Edit panel in TicketDetailModal listing all `ticket.attachments` sorted by `addedAt` descending. Each row SHALL show type icon, filename, date, and a "Preview" or "Open" link that opens the file in a new browser tab via the serve endpoint.

#### Scenario: Ticket has attachments
- **WHEN** the TicketDetailModal opens and `ticket.attachments` is non-empty
- **THEN** an "Attachments" section is visible with one row per attachment

#### Scenario: Ticket has no attachments
- **WHEN** `ticket.attachments` is empty or absent
- **THEN** the Attachments section is hidden (not rendered)

#### Scenario: User clicks Preview/Open
- **WHEN** the user clicks the link on an attachment row
- **THEN** the file opens in a new browser tab via `GET /attachments/:attachmentId`

#### Scenario: User removes attachment from Resources section
- **WHEN** the user clicks the remove icon on a Resources row
- **THEN** the file is deleted from server, the row animates out, and `ticket.attachments` is updated
