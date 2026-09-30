# Local subscription usage

The left sidebar's **Usage** section shows the currently signed-in Claude and Codex account allowance across all activity, including use outside Specrails. Each provider window has its own consumed percentage and reset time; this is separate from job tokens, billed costs and project budgets.

The sidebar displays static provider cards with separate labeled quota bars. There is no floating usage panel or clickable provider card. Full reset times and data details are available in Subscription usage in global app settings. The view is always detailed, without view selectors or provider-management buttons. The collapsed sidebar shows a usage status icon. Unknown measurements are unavailable, never assumed to be zero.

If neither CLI is detected, the section explains installing Claude or Codex and signing in with that CLI. It does not run usage queries for missing tools. After installation or changing login, press Refresh. An API-key login may have no subscription allowance. An incompatible Codex CLI must be updated rather than queried through a paid prompt.

Updates are demand-driven while the app and a usage surface are visible. Manual refresh has a 30-second floor and provider failures can impose a longer cooldown. Data becomes stale after five minutes or a passed reset; refresh confirms the new allowance. A transient failure can retain figures from the same account with a stale label. Sign-out/auth failures clear cached figures.

Credentials remain local to the server and are never sent to the frontend. The feature does not manage accounts, change provider selection, stop jobs or store usage history. Claude OAuth/Keychain availability depends on the installed CLI and OS access policy; Codex uses read-only app-server methods. Unsupported login or platform combinations show a descriptive state. Only the current host login is supported; remote/WSL account usage is not inferred.

The Usage section starts collapsed. Its header toggles the provider cards with an accessible expanded state and chevron; the separate refresh button does not toggle the section.

Opening the Usage section requests a refresh each time, retaining cached measurements while collection runs and respecting service cooldowns. Closing it does not request a refresh.

Final placement: Usage is in the shared footer status bar in board and mission modes, removed from the left sidebar. Hover, focus or click opens the provider cards above the footer; opening requests refresh. Pointer transfer to the menu stays open, leaving dismisses after a short delay, and Escape/outside interaction closes it. Mission mode uses the minimal status bar without spend polling. This supersedes prior sidebar placement.

Footer summaries show one quota per provider: account weekly when reported, otherwise the first account window, otherwise the first reported window. Values are never aggregated. The hover menu shows every individual quota and bar. There is no presentation selector or mode label.
