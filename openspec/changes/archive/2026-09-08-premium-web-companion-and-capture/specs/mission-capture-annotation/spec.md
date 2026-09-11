## ADDED Requirements

### Requirement: Annotate completed selections
Completed browser captures SHALL open the annotation editor before attachment, including development, native selection and all-size variants.

#### Scenario: Complete a page region selection
- **WHEN** a user confirms a valid region in Select to add to mission
- **THEN** the annotation modal opens with the selected capture and no attachment is sent until confirmed.

### Requirement: Recoverable editing
The editor SHALL retain edits on attachment failure and own escape handling while active so the parent browser does not silently discard work.

#### Scenario: Attachment fails
- **WHEN** saving the annotated capture returns an error
- **THEN** the editor remains available for correction or retry with the annotations preserved.
