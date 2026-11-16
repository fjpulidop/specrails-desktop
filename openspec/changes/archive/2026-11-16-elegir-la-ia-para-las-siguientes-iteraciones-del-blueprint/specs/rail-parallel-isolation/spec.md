# Spec Delta

## ADDED Requirements

### Requirement: Worktrees retain a local OpenSpec configuration
When neither OpenSpec config spelling exists in the checkout, overlay SHALL copy the first available openspec/config.yaml or config.yml from ordered project roots into the worktree. It SHALL copy no specs or changes, preserve existing configuration, refuse writes through an openspec directory symlink, and include the copy in existing overlay ownership and cleanup authentication.

#### Scenario: Repository fallback supplies configuration
- **WHEN** the primary source lacks configuration and the repository fallback contains untracked OpenSpec configuration and changes
- **THEN** the worktree receives a local config copy and receives no changes directory

#### Scenario: Existing alternate spelling wins
- **WHEN** the checkout has openspec/config.yml and a source offers config.yaml
- **THEN** overlay preserves the checkout config and does not create config.yaml

#### Scenario: Directory symlink is preserved
- **WHEN** the worktree openspec directory is a symlink
- **THEN** overlay writes no configuration through that symlink

#### Scenario: Edited copy loses cleanup authorization
- **WHEN** a copied configuration is subsequently edited
- **THEN** revalidated cleanup evidence no longer authorizes removing that edited file
