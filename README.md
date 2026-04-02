<p align="center"><img src="assets/decodie-logo.png" alt="Decodie" width="200"></p>

# Decodie for VSCode

View and create [Decodie](https://github.com/owenbush/decodie-ui) learning entries directly in your editor.

## Features

### Sidebar Entry Browser
As you navigate code, the Decodie sidebar automatically shows learning entries associated with the current file. Entries are matched using content-based anchors (function signatures, class declarations) that survive refactoring.

Each entry displays:
- Experience level badge (foundational, intermediate, advanced, ecosystem)
- Code snippet with the relevant pattern
- Collapsible explanation and alternatives considered
- External documentation links
- Reference resolution status

### Right-Click Analysis
Highlight code or right-click a file to analyze it with Claude. New Decodie entries are generated and immediately appear in the sidebar.

### Gutter Indicators
Lines with associated Decodie entries show subtle gutter markers. Hover to see the entry title.

## Setup

### 1. Install the extension
Install from the [VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=owenbush.decodie-vscode) or search "Decodie" in the Extensions panel.

### 2. Have a .decodie/ directory
The extension activates when your workspace contains a `.decodie/index.json` file. Generate entries using the [Decodie Claude Code skill](https://github.com/owenbush/decodie-skill) or by using the right-click analyze feature.

### 3. Configure API access (for analysis)
To use the right-click analyze feature, provide Claude API credentials in `.decodie/.env`:

```env
# Option A: OAuth token
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...

# Option B: API key
CLAUDE_API_KEY=sk-ant-api03-...
```

Alternatively, set `decodie.apiKey` in VSCode settings.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `decodie.apiKey` | `""` | Anthropic API key (fallback) |
| `decodie.model` | `claude-sonnet-4-6` | Claude model for analysis |

## The Decodie Ecosystem

- **[Decodie Skill](https://github.com/owenbush/decodie-skill)** - Claude Code skill for real-time and retroactive code documentation
- **[Decodie UI](https://github.com/owenbush/decodie-ui)** - Web-based browser for learning entries
- **[Decodie DDEV](https://github.com/owenbush/decodie-ddev)** - DDEV add-on for local development

## License

MIT
