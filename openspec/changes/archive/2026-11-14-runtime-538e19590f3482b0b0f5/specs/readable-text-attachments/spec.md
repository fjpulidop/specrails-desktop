# Spec Delta

## Purpose

Lets users attach any readable text or code file to an agent or Explore conversation and refuses everything else with a clear reason, without changing the rules for spec and ticket attachments.

## ADDED Requirements

### Requirement: Conversation attachments accept readable text by content

An agent or Explore conversation upload SHALL be accepted when its type is a rich type (image, PDF, Excel) or when the file content is readable text, regardless of file extension or reported MIME type. Accepted generic text SHALL be stored with MIME type `text/plain`, and the AI SHALL receive its content inside a `<user-attachment>` block.

#### Scenario: Markdown, SQL, TypeScript and YAML attach to an agent conversation
- **WHEN** the user attaches `.md`, `.sql`, `.ts` and `.yaml` files to an agent conversation
- **THEN** each upload succeeds and the AI receives each file's text in a `<user-attachment>` block

#### Scenario: Markdown and SQL attach to an Explore conversation
- **WHEN** the user attaches a `.md` and a `.sql` file to an Explore conversation
- **THEN** each upload succeeds and the AI can read the file content

#### Scenario: Unknown extension with text content
- **WHEN** the user attaches a `.log` file whose browser-reported type is empty or unrecognised
- **THEN** it is accepted as `text/plain`

### Requirement: Text detection edge cases

Readable-text detection SHALL inspect only a bounded prefix of the file. It SHALL accept empty files, UTF-8 with or without a BOM, UTF-16 text with a BOM, text with very long lines and text with only a negligible share of stray control characters. It SHALL refuse content containing NUL bytes (other than UTF-16 with a BOM), invalid UTF-8, or a significant share of control characters.

#### Scenario: BOM and UTF-16 text
- **WHEN** a UTF-8 file with a BOM or a UTF-16 file with a BOM is attached
- **THEN** it is accepted and the AI receives the decoded text without BOM characters

#### Scenario: Very long single line
- **WHEN** a text file made of one very long line is attached
- **THEN** it is accepted

#### Scenario: Binary-looking content
- **WHEN** a file whose prefix contains NUL bytes or mostly control characters is attached
- **THEN** it is refused

### Requirement: Non-text files are refused with a reason

A conversation upload that is neither a rich type nor readable text SHALL be refused with HTTP 400 and an error message that names the file and states it is not a text file. Nothing SHALL be stored for the refused file. In a multi-file selection or drop, other files SHALL still upload.

#### Scenario: Zip or executable refused
- **WHEN** the user attaches a zip archive or an executable
- **THEN** the response is 400 with a message naming the file and saying it is not a text file, and nothing is stored

#### Scenario: One refusal does not block the rest
- **WHEN** the user drops a `.md` file and a zip together
- **THEN** the `.md` file attaches and the zip shows its refusal message

### Requirement: Conversation pickers apply no type filter

The file picker and drag-and-drop of agent and Explore conversation composers SHALL NOT hide or reject files by type on the client. Type decisions SHALL be made by the server.

#### Scenario: Picker shows every file
- **WHEN** the user opens the attach picker in an agent or Explore conversation
- **THEN** no file type is filtered out

### Requirement: Existing limits, rich types and safety are preserved

Images, PDF and Excel attachments SHALL behave as before, and a PDF named with an image extension SHALL keep `application/pdf`. The existing 25 MB size limit and its error SHALL apply. Stored names SHALL stay sanitised and confined to the managed attachment directory, and attachment content SHALL still be wrapped as untrusted data with any `</user-attachment>` sequence escaped.

#### Scenario: Oversized file
- **WHEN** a file larger than the existing limit is attached
- **THEN** it is refused with the existing size error

#### Scenario: PDF named as PNG
- **WHEN** a PDF reported as `application/pdf` with a `.png` name is attached
- **THEN** it is stored as `application/pdf`

#### Scenario: Closing tag inside content
- **WHEN** an attached text file contains `</user-attachment>`
- **THEN** the sequence is escaped in the block given to the AI

### Requirement: Spec and ticket attachments are unchanged

Attachments on real tickets and on specs created through the propose-spec flow SHALL keep their current type rules. The readable-text rule SHALL apply on the shared ticket attachment route only when the caller explicitly opts in for a pending Explore spec.

#### Scenario: Unsupported type on a ticket
- **WHEN** a type that was previously unsupported is attached to a ticket or via propose-spec
- **THEN** it is refused exactly as before

#### Scenario: Opt-in ignored for real tickets
- **WHEN** the opt-in is sent for a numeric ticket id
- **THEN** the previous type rules still apply
