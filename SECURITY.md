# Security Policy

DeCloud gives whoever holds the passcode a shell on the host machine, so
we treat security reports as the top priority.

## Reporting a vulnerability

**Please do not open a public GitHub issue, discussion or pull request for
security problems.**

Report privately through either channel:

- **GitHub private vulnerability reporting (preferred):**
  <https://github.com/realvitali/decloud/security/advisories/new>
- **Email:** `security@<your-domain>` <!-- OWNER: replace with a real, monitored address, or delete this line -->

Please include:

- the DeCloud version (`./decloud version`, or Settings → About)
- your OS and how DeCloud is exposed (localhost only, Tailscale Serve,
  Tailscale Funnel, cloudflared, LAN bind, Docker)
- steps to reproduce, or a proof of concept
- the impact as you understand it

## What to expect

- We aim to acknowledge a report within **3 business days** and to send
  an initial assessment within **10 business days**.
- We'll agree on a disclosure date with you. Fixes ship as a normal
  release, which the in-app updater picks up. The advisory is published
  once the release is out.
- We're happy to credit you in the advisory and changelog. Tell us if
  you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes. Update from Settings → About
or with `decloud update`.

## Scope

In scope: this repository (the Flask app, the installers, the `decloud`
CLI/TUI, the self-updater, the Lab agent and the release workflow).

Out of scope: problems in Tailscale, cloudflared, Ollama, ComfyUI or
other third-party software (report those upstream), and attacks where the
attacker already knows the passcode or holds a valid session token. The
passcode holder is the owner and is meant to have a shell. Attacks that
abuse a logged-in owner's browser (CSRF, XSS, cross-site WebSocket, DNS
rebinding) **are** in scope.
