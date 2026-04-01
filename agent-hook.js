#!/usr/bin/env node

/**
 * Lightweight hook handler for Insomnia integrations.
 * Called by Claude Code hooks (and similar tools) to signal activity.
 * No Electron dependency — just reads stdin and writes to a JSON file.
 *
 * Usage:
 *   echo '{"session_id":"abc"}' | node agent-hook.js stay-awake <integration-id>
 *   echo '{"session_id":"abc"}' | node agent-hook.js allow-sleep <integration-id>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.insomnia');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'agent-sessions.json');

const command = process.argv[2];
const integrationId = process.argv[3] || 'unknown';

function readSessions() {
  try {
    if (fs.existsSync(SESSIONS_FILE)) {
      return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    }
  } catch {}
  return { sessions: {} };
}

function writeSessions(data) {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  data.last_updated = new Date().toISOString();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch { resolve({}); }
    });
    // Timeout after 1 second if no stdin
    setTimeout(() => resolve({}), 1000);
  });
}

async function main() {
  const input = await readStdin();
  const sessionId = input.session_id || 'default';
  const key = `${integrationId}:${sessionId}`;

  const sessions = readSessions();

  if (command === 'stay-awake') {
    if (!sessions.sessions[key]) {
      sessions.sessions[key] = {
        integration: integrationId,
        session_id: sessionId,
        created_at: new Date().toISOString()
      };
    }
    sessions.sessions[key].last_activity = new Date().toISOString();
    writeSessions(sessions);
  } else if (command === 'pending-response') {
    // UserPromptSubmit — Claude is now generating a response
    if (!sessions.sessions[key]) {
      sessions.sessions[key] = {
        integration: integrationId,
        session_id: sessionId,
        created_at: new Date().toISOString()
      };
    }
    sessions.sessions[key].last_activity = new Date().toISOString();
    sessions.sessions[key].pending_response = true;
    writeSessions(sessions);
  } else if (command === 'response-done') {
    // Stop hook — Claude finished the full response turn, clear pending flag
    if (sessions.sessions[key]) {
      sessions.sessions[key].last_activity = new Date().toISOString();
      delete sessions.sessions[key].pending_response;
      writeSessions(sessions);
    }
  } else if (command === 'allow-sleep') {
    delete sessions.sessions[key];
    writeSessions(sessions);
  }

  process.exit(0);
}

main();
