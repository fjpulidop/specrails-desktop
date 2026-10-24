<!-- guide-revision: mission-first-v1 -->

# Review a delivery in the app {#review-a-delivery}

A delivery that is ready for review has two views: **Overview** (the verdict, the evidence and the decision buttons) and **Changes** (what the delivery actually changed). Open the review from the delivery's **Review** button, then choose **Changes**.

## Read the changes

The file list on the left shows every changed file with its status (added, modified, deleted, renamed), its `+` and `−` line counts and a tick once you mark it viewed. The diff on the right loads one file at a time, so a large change stays fast. Switch between **Unified** and **Split** layouts; Specrails remembers your choice. A very large file shows its first lines with **Load full file diff**; a binary file is listed as binary.

The changes are measured from the point where the delivery branched off its base branch, so work that landed on the base afterwards does not appear. When a delivery has no combined branch yet you can pick which spec's branch to read.

## Reviewer notes on the code

The reviewer's findings, the risks it flagged and any review comments the run was launched to resolve appear under the line they are about. Notes that name no file or line are listed above the file list, so nothing is hidden. Older deliveries, and reviewers that did not name a place, show their findings in that list.

## Ask the agent to change something

Select lines by clicking their numbers (Shift-click extends the range), then choose **Ask agent to change this** and describe the change. Specrails saves it as review feedback on the spec, with the file, the line range and the selected code, and shows a message with a link to the spec. The next run on that spec is briefed with it. To start the run now, use **Ask for changes** on the Overview. There are no comment threads between people here; discuss with your team on GitHub.

## Open in your editor

**Open in editor** opens the file, at the selected line, in VS Code, Cursor or a JetBrains IDE. Choose the editor in **Settings → Code → Editor**. The file opens from your own checkout of the project, where the review branch may not be checked out.

## Keyboard

| Key | Action |
| --- | --- |
| `j` / `k` | Next / previous changed file |
| `n` / `p` | Next / previous reviewer note |
| `v` | Mark the file viewed |

The keys are ignored while you type in a field. Marking a file viewed is private to you; if the file changes in a later revision it shows **Changed since you viewed it** and counts as unviewed again.
