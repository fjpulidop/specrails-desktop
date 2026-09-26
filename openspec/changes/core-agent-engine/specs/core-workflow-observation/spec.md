## ADDED Requirements

### Requirement: Event-derived steps and accounting
Desktop SHALL project ordered Core events into nested steps, branches and one accounting row per AI attempt. Replayed events MUST NOT duplicate costs; unknown usage MUST remain null.

#### Scenario: Restart replay
- **WHEN** terminal attempt events are read twice
- **THEN** the run totals and accounting row count remain unchanged

#### Scenario: Unknown cost
- **WHEN** Core reports tokens but no cost
- **THEN** Desktop preserves the unknown cost and the reported token counts

### Requirement: Verified delivery
Desktop SHALL keep delivery ownership and require succeeded status, completion.ok and candidate-matched verification for graphs that write.

#### Scenario: Unverified success
- **WHEN** a writing graph reports completion.ok without verification
- **THEN** the rail does not move to review

#### Scenario: Negative verdict
- **WHEN** Core succeeds with completion.ok=false
- **THEN** Desktop records a negative result without classifying it as process failure

### Requirement: Steering and trace observation
Desktop SHALL send steering through the retained Core signal CLI and distinguish acceptance from consumption at an attempt boundary. Existing chat transports SHALL remain unchanged.

#### Scenario: Pending steering
- **WHEN** signal accepts text while a provider turn is running
- **THEN** the UI shows accepted until Core records consumption at a subsequent attempt
