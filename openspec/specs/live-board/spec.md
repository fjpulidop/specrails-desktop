# live-board Specification

## Purpose
Defines what the live board's cards open, in the main window and in the board's own native window.

## Requirements

### Requirement: Cards open what exists
A live board card SHALL link only to a mission that exists. An Intent session whose mission is deleted or in the trash SHALL have no card unless an inbox item speaks for it; any other card SHALL lose the link and open its run.

#### Scenario: Cards open what exists
- **WHEN** an Intent session's mission is in the trash and another session's mission exists
- **THEN** the board shows only the session whose mission exists

### Requirement: The board window opens runs and reviews in place
In the board's own native window, opening a run or a review SHALL show it over the board in that window, in the card's project, without changing the main window's project; opening a mission or running another inbox action SHALL happen in the main window while the board window stays open.

#### Scenario: Window opens in place
- **WHEN** the person opens a run card in the board window
- **THEN** the run's detail opens over the board, and closing it returns to the board
