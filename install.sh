#!/usr/bin/env bash
set -e

echo "Installing memorex..."

# Install dependencies and build
npm install
npm run build

# Single atomic settings update: MCP server + hooks
SETTINGS="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

node -e "
const fs = require('fs');
const cwd = process.cwd();
const settingsPath = '${SETTINGS}'.replace('\$HOME', process.env.HOME);

let s = {};
try { s = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

// MCP server
if (!s.mcpServers) s.mcpServers = {};
s.mcpServers.memorex = { command: 'node', args: [cwd + '/dist/index.js'] };

// Hooks
if (!s.hooks) s.hooks = {};

// SessionStart: reset session + print count
s.hooks.SessionStart = s.hooks.SessionStart || [];
if (!s.hooks.SessionStart.some(g => g.hooks?.some(h => h.command?.includes('memorex')))) {
  s.hooks.SessionStart.push({
    matcher: '',
    hooks: [{ type: 'command', command: 'node ' + cwd + '/dist/hooks/start.js 2>/dev/null || true' }]
  });
}

// Stop: silent prune
s.hooks.Stop = s.hooks.Stop || [];
if (!s.hooks.Stop.some(g => g.hooks?.some(h => h.command?.includes('memorex')))) {
  s.hooks.Stop.push({
    matcher: '',
    hooks: [{ type: 'command', command: 'node ' + cwd + '/dist/hooks/end.js 2>/dev/null || true' }]
  });
}

// UserPromptSubmit: auto-inject top relevant memories (zero cost when empty)
s.hooks.UserPromptSubmit = s.hooks.UserPromptSubmit || [];
if (!s.hooks.UserPromptSubmit.some(g => g.hooks?.some(h => h.command?.includes('memorex')))) {
  s.hooks.UserPromptSubmit.push({
    matcher: '',
    hooks: [{ type: 'command', command: 'node ' + cwd + '/dist/hooks/prompt.js 2>/dev/null || true' }]
  });
}

// PreCompact: snapshot the session so context survives compaction
s.hooks.PreCompact = s.hooks.PreCompact || [];
if (!s.hooks.PreCompact.some(g => g.hooks?.some(h => h.command?.includes('memorex')))) {
  s.hooks.PreCompact.push({
    matcher: '',
    hooks: [{ type: 'command', command: 'node ' + cwd + '/dist/hooks/precompact.js 2>/dev/null || true' }]
  });
}

fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
console.log('Configured: MCP server + SessionStart/Stop/UserPromptSubmit/PreCompact hooks');
"

echo ""
echo "Done! Restart Claude Code to activate memorex."
echo ""
echo "Limits: 200 memories max | 5 saves/session | 4000 char body cap"
