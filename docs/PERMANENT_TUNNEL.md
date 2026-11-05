# Permanent Tunnel Setup

DeCloud uses **Tailscale Serve** by default. This gives devices on your tailnet a URL like `https://your-machine.tail1234.ts.net`.

> **Funnel makes DeCloud public.** Anyone on the internet can open the URL, and the only thing between them and your machine is the passcode. **The passcode unlocks a shell on this machine** (terminal, files, updates). Never share it. If only your own devices need access, use [Private-Only Mode](#private-only-mode-no-public-url) (Tailscale Serve) instead.

## Quick Setup

1. **Install Tailscale** (if not already):
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Start Tailscale**:
   ```bash
   sudo tailscale up
   ```

3. **Start DeCloud** — it starts private Serve for your tailnet:
   ```bash
   ./decloud start
   ```

Your URL: `https://your-machine-name.tail1234.ts.net`

## Why Tailscale Serve?

- **Permanent URL** — never changes, bookmark it
- **End-to-end encrypted** — WireGuard + TLS 1.3
- **Free Tailscale account required** — the free tier is enough
- **Works on any network** — no port forwarding

## Don't share your passcode

The passcode is not a "view-only" password: it unlocks the interactive
terminal, the file manager (including delete/shred) and the self-updater —
in effect, a shell on this machine as your user. Treat it like your login
password:

- Don't send it to friends or family, or share it alongside the URL or QR code.
- If you think it leaked, change it in Settings (this signs out every device).
- DeCloud is a single-owner app; there are no per-person accounts.

## Alternative: Cloudflare Named Tunnel

If you prefer your own domain (`decloud.yourdomain.com`):

1. Buy a domain (~$10/year) or use a free subdomain
2. Sign up for [Cloudflare](https://cloudflare.com) (free)
3. Add your domain to Cloudflare
4. Run:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create decloud
   cloudflared tunnel route dns decloud decloud.yourdomain.com
   ```
5. Edit `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/user/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: decloud.yourdomain.com
       service: http://localhost:8899
     - service: http_status:404
   ```
6. Allow the hostname (DeCloud refuses unknown Host headers), in `.env`:
   ```bash
   DECLOUD_ALLOWED_HOSTS=decloud.yourdomain.com
   ```
7. Start: `cloudflared tunnel run`

The same warning applies: this is public, and the passcode is a shell.

## Private-Only Mode (No Public URL)

Recommended if only your own devices need DeCloud. Tailscale Serve gives
HTTPS on your tailnet only — nothing is reachable from the internet:

1. Install and connect Tailscale on the host and phone.
2. Start DeCloud and private Serve:
   ```bash
   ./decloud start
   ```
3. Open `https://your-machine.tail1234.ts.net` from any device signed in to
   your tailnet.

## Troubleshooting

**"Serve failed"**
- Check Tailscale is running: `tailscale status`
- Check Serve is enabled and tailnet-only: `tailscale serve status`
- Restart: `./decloud restart`

**"URL not working"**
- Wait 30 seconds for DNS propagation
- Check: `curl -I https://your-machine.tail1234.ts.net`
- Regenerate QR: `./decloud qr`

**"Can't open it from my phone"**
- Make sure you use the full URL (including `https://`)
- Check your passcode is correct
- Connect your phone to the same tailnet and check `tailscale serve status`.
