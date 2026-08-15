# Contributing to DeCloud

Thanks for your interest in making DeCloud better! This is an open-source project driven by the community.

## Ways to Contribute

- **Bug reports** — Open an issue with steps to reproduce, your OS, and logs
- **Feature ideas** — Open an issue with the `feature-request` label
- **Code** — Fix a bug or build a feature (see below)
- **Docs** — Improve the README, add guides, fix typos
- **Testing** — Try DeCloud on your hardware and report what works/breaks

## Development Setup

```bash
git clone https://github.com/<org>/decloud ~/decloud
cd ~/decloud
./install.sh  # sets up venv + deps
source .venv/bin/activate
python app.py
```

Open `http://localhost:8899` in your browser.

## Code Style

- **Python**: Follow PEP 8. Use type hints where practical. Keep routes in `routes/`, shared state in `shared.py`.
- **JavaScript**: Vanilla JS, no build step. One file per app in `static/js/apps/`, shared modules in `static/js/modules/`.
- **CSS**: Single file (`static/css/app.css`). No preprocessors.
- **No frameworks**: DeCloud intentionally avoids React, Vue, etc. The frontend is vanilla JS + Flask templates. Respect that.

## Adding a New App

1. Create `routes/myapp.py` with a Blueprint
2. Register it in `app.py`
3. Create `static/js/apps/app-myapp.js`
4. Create `static/js/modules/myapp.js` for the UI module
5. Add the app tile to `templates/index.html`
6. Add any env vars to `.env.example` with sensible defaults

See `routes/books.py` and `static/js/apps/app-audiobooks.js` as reference.

## Pull Request Process

1. Fork the repo and create a branch: `git checkout -b fix/my-bugfix`
2. Make your changes. Keep commits focused.
3. Test locally: `python app.py` and verify your feature works
4. Run existing tests if any: `python -m pytest tests/`
5. Open a PR with a clear description of what changed and why

## Architecture Overview

```
app.py              → Flask app, blueprint registration, startup
shared.py           → Config, env vars, shared utilities
routes/             → One file per feature area (Blueprints)
  books.py          → Audiobook reader
  lego.py           → File browser
  ollama.py         → AI chat proxy
  system.py         → System monitor
  terminal.py       → Web terminal (WebSocket)
  voice.py          → STT/TTS
  comfy.py          → Image generation
  ...
static/js/apps/     → Frontend logic per app
static/js/modules/  → UI rendering modules
static/css/         → Styles
templates/          → Jinja2 templates
```

## Questions?

Open an issue with the `question` label. No question is too basic.
