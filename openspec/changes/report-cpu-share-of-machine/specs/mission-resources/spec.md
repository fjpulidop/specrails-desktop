## ADDED Requirements

### Requirement: CPU as a share of the machine
Every CPU value the Resources views and their API report (totals, categories, items, mission entries and recorded history) SHALL be a share of the whole machine, from 0 to 100 %: the per-core measurement divided by the logical cores and capped at 100. The responses SHALL carry the core count, and the views SHALL explain the scale.

#### Scenario: Emulator on a 10-core Mac
- **WHEN** an Android emulator keeps 3.4 cores busy on a 10-core Mac
- **THEN** its row reads 34 % and no total exceeds 100 %
