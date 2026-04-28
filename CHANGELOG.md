# Changelog

## 0.7.0

- Render overview-shape entries (`decision_type: "overview"`) in the sidebar detail view — Purpose, Structure, Entry Points, and Dependencies sections, gated on field presence so legacy entries are unaffected
- Search now indexes overview content (`purpose` / `structure` / `entry_points` / `dependencies`) so it surfaces in the All Entries search bar
- Updated to `@owenbush/decodie-core` 0.5.0 (adds `OverviewSessionEntry` variant and `"overview"` to `DecisionType`)

## 0.6.3

- Show stale badge on entries whose source files have changed since they were last verified by `/decodie:verify`
- Show truncated `verified_sha` chip on the entry detail view

## 0.6.2

- Updated to @owenbush/decodie-core 0.4.0 (sources, verified_sha, stale lifecycle fields)
- Add GitHub Actions workflow for publishing to VS Code Marketplace and Open VSX

## 0.6.0

- Add search to All Entries tab
- Add Refresh link to empty states in sidebar
- Docs: add decodie-github-action and decodie-github-bot to ecosystem table

## 0.5.0

- **Decodie: Explain Selection** — right-click any code selection to get a
  detailed explanation with summary, breakdowns of complex sections, issues
  with severity levels, and improvement suggestions. Ephemeral by default
  with a "Save as entry" button to persist valuable explanations.
- Updated to @owenbush/decodie-core 0.3.0 (breakdowns, issues, improvements schema)
- Fix: sidebar restores entries when re-opened after switching tabs
- Fix: unsaved explain results are preserved when sidebar is hidden and re-opened
- Fix: explain/analyze works on first click when sidebar was closed (message queuing)

## 0.3.0

- Q&A conversations: ask questions about any entry directly in the sidebar
- Streaming responses with markdown rendering (powered by marked)
- Conversation history persists to .decodie/conversations/
- CodeLens: clickable entry titles above lines with associated entries
- Hover tooltips with "View Entry" links on decorated lines
- Decodie branded Activity Bar icon (lightbulb with code brackets)
- Comprehensive getting started guide in README

## 0.2.0

- Tabbed sidebar: File, All Entries, and Entry detail views
- Clickable entries that open referenced files and jump to the anchor line
- Syntax highlighting in code snippets
- Collapsible filters on All Entries tab (level, type, topic)
- Analysis status shown in sidebar with spinner
- Sidebar auto-opens when analysis starts
- OAuth token support via Claude Agent SDK
- Improved JSON response handling for truncated responses
- Larger, more readable font sizes
- Comprehensive getting started guide in README

## 0.1.0

- Initial release
- Sidebar entry browser with automatic file matching
- Right-click analyze selection and file commands
- Editor gutter decorations for lines with entries
- FileSystemWatcher for live updates from concurrent Decodie skill usage
- Claude API integration for code analysis
