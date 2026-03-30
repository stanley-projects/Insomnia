# Insomnia Launch Checklist

A step-by-step guide to getting Insomnia published, installed, and discoverable by anyone who'd find it useful.

---

## 1. Polish the GitHub Repo
**What it is:** Making the repo look professional and searchable before you drive traffic to it.
**Why it matters:** GitHub is often the first thing someone sees. Topics make it show up in GitHub search. A license tells people they're allowed to use it.

**Steps:**
1. Go to `stanley-projects/Insomnia` on GitHub
2. Click the gear icon next to "About" (top right of the repo)
3. Add a description: `Keep your PC awake when it matters — smart sleep prevention for Windows`
4. Add topics (these make it searchable): `windows`, `electron`, `productivity`, `sleep`, `claude-code`, `ai-tools`, `system-tray`, `windows-app`
5. Add a license file: on the repo page → Add file → Create new file → name it `LICENSE` → GitHub will offer a template picker → choose **MIT** → commit it
6. Take 1-2 screenshots of the app (the main window + tray icon) and add them to `README.md` under a `## Screenshots` section

---

## 2. Rebuild the Installer as v1.2.0
**What it is:** Compiling the app into a `.exe` installer that anyone can download and run.
**Why it matters:** People can't install from source code. They need a ready-to-run installer. Version 1.2.0 now includes Cursor support and the permission-request fix, so the new build is worth releasing.

**Steps:**
1. Open a terminal in the project folder
2. Run: `npm run build`
3. Wait for it to finish — it takes 1-2 minutes
4. Find the output at `dist/Insomnia Setup 1.2.0.exe`
5. Test it: run that installer on your machine, confirm the app launches and works

---

## 3. Create the GitHub Release
**What it is:** A formal release on GitHub where you attach the installer for people to download.
**Why it matters:** This is the official download link. Winget and Scoop will both point to it. It also shows up on the repo's front page as "Latest Release."

**Steps:**
1. Go to `stanley-projects/Insomnia` → click **Releases** → **Draft a new release**
2. Click **Choose a tag** → type `v1.2.0` → click "Create new tag"
3. Set the release title: `Insomnia v1.2.0`
4. Write release notes, e.g.:
   ```
   ## What's New in v1.2.0
   - Added Cursor integration — keeps PC awake while Cursor is running
   - Insomnia now stays awake while waiting for Claude Code permission prompts
   - Installer and app polish
   ```
5. Drag and drop the `dist/Insomnia Setup 1.2.0.exe` file into the Assets section
6. Click **Publish release**

---

## 4. GitHub Pages Landing Page
**What it is:** A simple public website at `stanley-projects.github.io/Insomnia` with a download button.
**Why it matters:** A proper landing page makes it feel like a real product. It's something you can link to in blog posts, Reddit, and HN that looks better than a raw GitHub repo. It also shows up in Google search results.

**Steps:**
1. In the repo, create a folder called `docs/`
2. Create `docs/index.html` — a single-page site with: hero headline, feature bullets, screenshot, and a big "Download" button linking to the GitHub Release `.exe`
3. Go to repo **Settings** → **Pages** → set Source to "Deploy from a branch", branch `master`, folder `/docs`
4. Save — GitHub will publish it within a minute at `https://stanley-projects.github.io/Insomnia`
5. Add that URL to the repo's About section on GitHub

---

## 5. Submit to winget (Microsoft's Official Package Manager)
**What it is:** Winget is Windows' built-in package manager. Once listed, anyone can install Insomnia by typing `winget install StanleyProjects.Insomnia` in a terminal.
**Why it matters:** This is the biggest discoverability win for Windows apps. Power users search winget. It also lends legitimacy — it means Microsoft has reviewed the submission.

**Steps:**
1. Install the winget validation tool: `winget install Microsoft.WingetCreate`
2. Run: `wingetcreate new https://github.com/stanley-projects/Insomnia/releases/download/v1.2.0/Insomnia.Setup.1.2.0.exe`
3. Fill in the prompts: Publisher = `StanleyProjects`, App name = `Insomnia`, version = `1.2.0`
4. It generates manifest files in a folder
5. Fork `github.com/microsoft/winget-pkgs` on GitHub
6. Copy the generated manifests into `manifests/s/StanleyProjects/Insomnia/1.2.0/`
7. Submit a pull request — the bot will validate it automatically
8. Wait for approval (usually 1-3 days if the manifest is clean)

---

## 6. Submit to Scoop
**What it is:** Scoop is a popular community package manager for Windows developers. Once listed, people can install with `scoop install insomnia`.
**Why it matters:** Scoop is widely used by developers — exactly the audience who'd want Insomnia. It's also faster to get listed than winget (community-run, no formal review queue).

**Steps:**
1. Find the SHA256 hash of the installer:
   - PowerShell: `Get-FileHash "dist\Insomnia Setup 1.2.0.exe" -Algorithm SHA256`
2. Create a file called `insomnia.json`:
   ```json
   {
     "version": "1.2.0",
     "description": "Keep your PC awake when it matters",
     "homepage": "https://github.com/stanley-projects/Insomnia",
     "license": "MIT",
     "url": "https://github.com/stanley-projects/Insomnia/releases/download/v1.2.0/Insomnia.Setup.1.2.0.exe",
     "hash": "<SHA256 from step 1>",
     "installer": { "type": "nsis" },
     "checkver": {
       "github": "https://github.com/stanley-projects/Insomnia"
     },
     "autoupdate": {
       "url": "https://github.com/stanley-projects/Insomnia/releases/download/v$version/Insomnia.Setup.$version.exe"
     }
   }
   ```
3. Fork `github.com/ScoopInstaller/Extras` (the main community bucket)
4. Add `insomnia.json` to the `bucket/` folder
5. Submit a pull request with title: `insomnia: Add version 1.2.0`

---

## 7. Write a Blog Post (Dev.to or Hashnode)
**What it is:** A short post explaining the problem Insomnia solves and how you built it.
**Why it matters:** Dev.to and Hashnode have large audiences of developers. A good post can drive hundreds of downloads and GitHub stars in a day. It also gives you something to link to when sharing on Reddit/HN — feels less like self-promotion, more like sharing a story.

**Structure:**
- Hook: "I was running a long Claude Code session, stepped away, came back to a dead screen and a broken session..."
- The problem: PC sleep killing AI coding sessions
- What I built: quick overview with screenshot
- How it works: hooks, process watching, 90-second sessions
- Download link + GitHub link
- Tag it: `#windows`, `#productivity`, `#ai`, `#electron`

---

## 8. Post on Reddit
**What it is:** Sharing in relevant subreddits where the target audience hangs out.
**Why it matters:** Reddit can send a spike of thousands of visitors if it resonates. The key is posting in the right communities with the right framing — show the problem, not just the product.

**Subreddits and angles:**
- **r/ClaudeAI** — lead with the Claude Code hook integration, that's unique
- **r/ChatGPT** or **r/LocalLLaMA** — frame it as "for anyone running long AI sessions"
- **r/Windows11** — frame it as a lightweight sleep-prevention utility
- **r/programming** / **r/coding** — mention the Electron + zero-dependency approach

**Post format:** Short title, 1-paragraph description of the problem it solves, screenshot, GitHub/download link. Don't just say "I made this" — describe the pain point first.

---

## 9. Post on Hacker News (Show HN)
**What it is:** HN's "Show HN" is a dedicated thread type for sharing things you've built.
**Why it matters:** HN has a technical audience who'd appreciate the hook-based Claude Code integration. A front-page Show HN can drive thousands of GitHub stars. Timing matters: best to post Tuesday–Thursday, 8–10am US Eastern.

**Format:**
```
Show HN: Insomnia – keeps your PC awake while Claude Code (or any app) is running

[link to GitHub or landing page]

Built this after too many Claude Code sessions getting killed by Windows sleep...
[2-3 sentences about how it works, especially the hook-based Claude detection]
```

---

## 10. Submit to AlternativeTo + Other Discovery Sites
**What it is:** Sites where people search for alternatives to existing tools.
**Why it matters:** People searching "caffeine for windows" or "prevent sleep windows" will find Insomnia. Passive, long-term discoverability.

**Sites to submit to:**
- **AlternativeTo** — `alternativeto.net` → Add software → fill in details, mark it as alternative to "Caffeine", "Amphetamine"
- **Product Hunt** — launch it as a product; best on a Tuesday/Wednesday morning
- **GitHub Awesome lists** — search for `awesome-windows` repos on GitHub and open a PR to add Insomnia
