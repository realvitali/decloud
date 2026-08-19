#!/usr/bin/env python3
"""DeCloud — your personal cloud, accessible from anywhere.

SECURE ARCHITECTURE:
  - App binds to 127.0.0.1 by default (never exposed to the network)
  - Runs plain HTTP on localhost — safe because it's not reachable externally
  - A tunnel (Tailscale Funnel or cloudflared) provides trusted HTTPS
  - The tunnel connects outbound — no inbound ports opened on the machine
  - All API endpoints require passcode authentication
  - Rate limiting on all routes

Binding to anything other than 127.0.0.1 prints a loud warning: the app
then relies on the passcode alone for LAN-visible traffic.
"""
import os, sys

# ─── Update safety net ────────────────────────────────────────────
# If the previous self-update is fresh and THIS boot fails during
# startup, check the last-good revision back out before exiting, so
# the service manager (systemd Restart=always) brings the working
# version up instead of crash-looping on broken code. Boot probes
# spawned by the updater skip this (they must not move the tree).
try:
    from shared import app, sock
    from routes import register_blueprints
    from routes.update import rollback_on_failed_boot, clear_marker_after_healthy_uptime
    from routes.update import read_update_meta
    register_blueprints(app, sock)
    if os.environ.get('DECLOUD_UPDATE_PROBE') != '1':
        _meta = read_update_meta()
        if _meta.get('state') in ('installed', 'rolled_back', 'prepared'):
            clear_marker_after_healthy_uptime()
except Exception as _boot_error:
    if os.environ.get('DECLOUD_UPDATE_PROBE') != '1':
        try:
            from routes.update import rollback_on_failed_boot
            if rollback_on_failed_boot():
                print('[DeCloud] startup failed after a recent update — '
                      'rolled back to the previous version. Restarting…',
                      flush=True)
        except Exception:
            pass
    raise


if __name__ == '__main__':
    PORT = int(os.environ.get('DECLOUD_PORT', '8899'))

    # Bind to localhost by default — never expose directly to the network.
    # Remote access is provided exclusively by a tunnel (Tailscale Funnel
    # or cloudflared). This means:
    #   - Zero open ports on the machine
    #   - No port scanning attacks possible
    #   - No need for local SSL certs (tunnel handles HTTPS)
    bind_host = os.environ.get('DECLOUD_HOST', '127.0.0.1')

    print(f'[DeCloud] Running on http://localhost:{PORT}')
    if bind_host not in ('127.0.0.1', 'localhost', '::1'):
        print('*' * 70)
        print(f'[DeCloud] WARNING: bound to {bind_host} — NOT localhost-only!')
        print('[DeCloud] Anyone on the same network can reach this app. Only')
        print('[DeCloud] do this when a passcode is set AND you know what you')
        print('[DeCloud] are doing (e.g. Tailscale Serve on the tailnet IP).')
        print('*' * 70)
    else:
        print('[DeCloud] Bound to localhost only — zero exposed ports.')
    print('[DeCloud] For remote/phone access, start a tunnel:')
    print(f'[DeCloud]   tailscale funnel {PORT}')
    print(f'[DeCloud]   (or: cloudflared tunnel --url http://localhost:{PORT})')
    print('[DeCloud] The tunnel provides trusted HTTPS automatically.')

    app.run(host=bind_host, port=PORT, debug=False, threaded=True)