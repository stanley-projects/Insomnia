# Insomnia — Keep Windows Awake During AI Coding Sessions

> **Insomnia is the smart Windows sleep-prevention utility that automatically keeps your PC awake while AI coding tools are actively working — and releases the sleep lock the moment they stop.**

**Prevent your PC from sleeping while Claude Code, Cursor, Aider, or Codex are working.**

Insomnia is a free, lightweight Windows app that keeps your computer awake — automatically when AI coding agents are running, when specific apps are active, or manually with a toggle. A smarter caffeine alternative for developers: no more losing progress to an untimely screen timeout.

![Windows](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/built%20with-Electron-47848f)
![License](https://img.shields.io/badge/license-MIT-green)
[![GitHub release](https://img.shields.io/github/v/release/stanley-projects/Insomnia?label=latest)](https://github.com/stanley-projects/Insomnia/releases/latest)
[![GitHub downloads](https://img.shields.io/github/downloads/stanley-projects/Insomnia/total?label=downloads)](https://github.com/stanley-projects/Insomnia/releases)

---

## The Problem

You're running Claude Code, Aider, or another AI coding tool. It's churning through a complex task. You step away for a few minutes — and your PC goes to sleep, killing the process. You come back to a broken session and lost work.

Setting your screen timeout to 2 hours works, but then your PC never sleeps when you actually want it to.

**Insomnia solves this.** It keeps your PC awake only when something is actively running that needs it, and gets out of the way the rest of the time.

## Features

### Smart Integrations

Insomnia has built-in support for AI coding tools with two types of monitoring:

| Integration | Type | How It Works |
|---|---|---|
| **Claude Code** | Hook-based | Knows when Claude is *actively working* (not just open). Wakes on tool use, sleeps when idle. |
| **Cursor** | Hook-based | Knows when Cursor Agent is *actively working*. Polls agent transcripts; idle = asleep. |
| **Aider** | Process-based | Keeps awake while `aider.exe` is running |
| **OpenAI Codex** | Hook-based | Knows when Codex is *actively working* (CLI, VS Code, or desktop). Uses Codex's `notify` config plus Codex session activity to track active work. |
| **Ollama** | Process-based | Keeps awake during local AI model inference |

The Claude Code integration is **hook-based** — it hooks directly into Claude Code's event system so your PC stays awake only while Claude is actively running tools and generating code, not when it's sitting idle waiting for your next prompt. Insomnia releases the moment Claude finishes a turn — Claude Code's `Stop` hook says so explicitly, rather than Insomnia inferring it from silence. That also means a single long tool call (a ten-minute build, a full test run) keeps your PC awake for its whole duration, even though no hook fires while it runs.

### App Watching

Add any application as a trigger. Insomnia auto-discovers all installed apps on your system:

- Windows Start Menu programs
- Registry-installed apps
- Microsoft Store apps
- Desktop shortcuts
- Or browse manually for any `.exe`

When a watched app is running, your PC stays awake. Close it, and Insomnia steps back.

### Manual Toggle

A simple on/off switch for when you just need your PC to stay awake right now. No questions asked.

### System Tray

Insomnia lives in your system tray, out of your way. The tray icon tells you at a glance:

- **Purple owl (eyes open)** — Staying Awake (keeping your PC on)
- **Grey owl (eyes closed)** — Inactive (normal sleep behavior)
- **Hover tooltip** — Shows exactly why it's awake: *"Staying awake for — Claude Code"*, *"Staying awake for — Manually triggered + Chrome"*

Close the window and it keeps running in the tray. Right-click for quick controls.

## Installation

### Download

Head to the [Releases](https://github.com/stanley-projects/Insomnia/releases) page and download the latest `.exe` installer.

**Nothing to set up.** On first launch Insomnia detects which AI coding tools you have installed and switches those integrations on for you, wiring up their hooks itself. Install a new tool later and it is picked up on the next launch. Nothing else is required — in particular you do **not** need Node.js installed; Insomnia runs its hooks on the runtime it ships with.

### winget

```
winget install StanleyProjects.Insomnia
```

### Scoop

```
scoop bucket add stanley-projects https://github.com/stanley-projects/scoop-stanley
scoop install stanley-projects/insomnia
```

### Build from Source

Requires [Node.js](https://nodejs.org/) (v18+).

```bash
git clone https://github.com/stanley-projects/Insomnia.git
cd Insomnia
npm install
npm start
```

## How It Works

Insomnia uses Electron's `powerSaveBlocker` API to prevent Windows from entering sleep mode. It evaluates whether to stay awake based on three signals:

1. **Manual toggle** — User explicitly wants the PC awake
2. **Process monitoring** — Polls `tasklist` every 10 seconds to check if watched apps are running
3. **Hook-based sessions** — For tools like Claude Code, lightweight hooks signal activity to a shared session file (`~/.insomnia/agent-sessions.json`). A Claude Code session ends when its `Stop` hook fires; otherwise it expires after 3 minutes of silence, or up to 30 minutes while `claude.exe` is still alive and a turn is still open.

If *any* trigger is active, the PC stays awake. When *all* triggers go inactive, normal sleep behavior resumes.

### Claude Code Integration Details

When you enable the Claude Code integration, Insomnia adds hooks to `~/.claude/settings.json` that fire on:

- `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Notification` → signal activity (stay awake)
- `SessionEnd` → signal idle (allow sleep)

This means your PC stays awake precisely while Claude is doing work — reading files, running commands, writing code — and goes back to normal the moment it stops. No wasted power, no interrupted sessions.

### Cursor Integration Details

When you enable the Cursor integration, Insomnia polls `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` every 5 seconds. Cursor writes these transcript files during active Agent sessions — they only change when the Agent is actively working, not while Cursor is sitting idle. When Insomnia detects a change, it signals activity and keeps Windows awake. The sleep lock is released within 3 minutes of the last transcript change.

### OpenAI Codex Integration Details

When you enable the OpenAI Codex integration, Insomnia adds a `notify` hook to `~/.codex/config.toml` for Codex CLI activity. For Codex surfaces that run through the persistent app server, including the VS Code extension and standalone app, Insomnia also watches Codex's local session transcript activity in `~/.codex/sessions`. Codex updates those transcripts during turns, and Insomnia treats those writes as active work without keeping the PC awake just because `codex.exe` is open.

## Configuration

Settings are stored in your Electron user data directory and persist across restarts:

- **Watched apps** — list of executables to monitor, each with an enable/disable toggle
- **Watched integrations** — AI tools with their monitoring type and enabled state
- **Manual awake state** — remembered across restarts

## Screenshots

| Main Window | Add Trigger — Integrations | Add Trigger — Apps | System Tray |
|---|---|---|---|
| ![Main window](docs/screenshot.png) | ![Integrations](docs/screenshot-integrations.png) | ![Apps](docs/screenshot-apps.png) | ![Tray](docs/screenshot-tray.png) |

---

## Use Cases

- **AI-assisted coding** — Prevent sleep while Claude Code, Cursor, Aider, or Codex work on long tasks
- **Long downloads** — Watch your browser or download manager
- **Video rendering** — Watch your editing software so your PC doesn't sleep mid-render
- **Presentations** — Manual toggle before you present, toggle off when done
- **Game updates** — Watch Steam or your game launcher during large updates
- **Compiling** — Watch your IDE during long builds
- **3D printing** — Watch your slicer or printer software
- **Local AI inference** — Keep awake while Ollama runs large language models

## Tech Stack

- **Electron** — Cross-platform desktop framework (Windows support)
- **Plain HTML/CSS/JS** — No React, no bundlers, no build tools
- **Zero external dependencies** — Only Electron itself
- **Windows APIs** — `tasklist` for process detection, PowerShell for app discovery, `powerSaveBlocker` for sleep prevention

## Contributing

Pull requests welcome. If you'd like to add an integration for another AI coding tool or improve app discovery, feel free to open a PR.

## Why Not Just Change Power Settings?

Setting your screen timeout to "Never" or 2+ hours works, but then your PC never sleeps when you actually want it to — wasting power and wearing your hardware. Insomnia keeps your PC awake **only** when something needs it, and automatically steps back when it doesn't. It's like caffeine for your PC, but smarter.

## FAQ

**How do I keep my Windows PC from sleeping?**  
Install Insomnia and add a trigger — an AI integration, a watched app, or the manual toggle. Insomnia uses Electron's `powerSaveBlocker` API to suppress the Windows sleep timer precisely while a trigger is active.

**Does Insomnia work with Claude Code?**  
Yes. Enable the Claude Code integration and Insomnia hooks into `~/.claude/settings.json`. Your PC wakes when Claude starts working and sleeps within 3 minutes after it goes idle.

**Does Insomnia work with Cursor?**  
Yes. Insomnia polls `~/.cursor/projects/*/agent-transcripts/**/*.jsonl` every 5 seconds. These files are only written during active Cursor Agent sessions, so the PC stays awake only while the Agent is working — not just because Cursor is open.

**Does Insomnia work with OpenAI Codex?**  
Yes, via two paths: a `notify` hook in `~/.codex/config.toml` (CLI) and session transcript polling at `~/.codex/sessions/**/*.jsonl` (VS Code extension and standalone app). All Codex surfaces are covered.

**How is Insomnia different from setting Windows sleep to "Never"?**  
Setting power settings to "Never" keeps the PC awake permanently. Insomnia keeps it awake *only* while a trigger is active — the moment all triggers go inactive, normal Windows sleep behavior resumes.

**Does it work for presentations, not just AI coding?**  
Yes. The manual toggle and app-watching features work for any scenario — presentations, video renders, long downloads, 3D printing, game updates, compiling.

**Is Insomnia free?**  
Yes. Free, open source, MIT licensed. No accounts, no subscriptions, no telemetry.

**Does it work on macOS or Linux?**  
No. Insomnia is Windows 10/11 only.

## License

MIT

---

<sub>keep windows awake · prevent windows from sleeping · stop pc from sleeping · caffeine windows · keep pc awake during presentation · prevent sleep windows 11 · sleep prevention utility · stay awake windows · windows power settings · no sleep mode · claude code keep awake · cursor keep awake · ai coding sleep prevention · keep windows awake programmatically · prevent idle sleep windows</sub>
