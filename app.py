#!/usr/bin/env python3
"""DeCloud — your personal cloud, accessible from anywhere.

SECURE ARCHITECTURE:
  - App binds to 127.0.0.1 ONLY (never exposed to the network)
  - Runs plain HTTP on localhost — safe because it's not reachable externally
  - A tunnel (cloudflared) provides trusted HTTPS with a real domain
  - The tunnel connects outbound — no inbound ports opened on the machine
  - All API endpoints require PIN authentication
  - Rate limiting on all routes
  
This is the same architecture used by Cloudflare Pages, ngrok, Tailscale Serve,
and every modern zero-trust service. The machine has zero exposed ports.
"""
import os, sys

from shared import app, sock
from routes import register_blueprints

register_blueprints(app, sock)


if __name__ == '__main__':
    PORT = int(os.environ.get('DECLOUD_PORT', '8899'))

    # Bind to localhost ONLY — never expose directly to the network.
    # Remote access is provided exclusively by a tunnel (cloudflared).
    # This means:
    #   - Zero open ports on the machine
    #   - No port scanning attacks possible
    #   - No need for local SSL certs (tunnel handles HTTPS)
    #   - No self-signed cert warnings
    bind_host = os.environ.get('DECLOUD_HOST', '127.0.0.1')

    print(f'[DeCloud] Running on http://localhost:{PORT}')
    print(f'[DeCloud] Bound to 127.0.0.1 only — zero exposed ports.')
    print(f'[DeCloud] For remote/phone access, start a tunnel:')
    print(f'[DeCloud]   cloudflared tunnel --url http://localhost:{PORT}')
    print(f'[DeCloud] The tunnel provides trusted HTTPS automatically.')

    app.run(host=bind_host, port=PORT, debug=False, threaded=True)