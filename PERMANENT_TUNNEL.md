# Permanent Tunnel Setup

DeCloud uses **Tailscale Serve** for secure, permanent remote access. This gives you a URL like `https://your-machine.tail1234.ts.net` that never changes — and it's **tailnet-only** (private to your own devices) by default.

## Quick Setup (Recommended)

1. **Install Tailscale** (if not already):
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Start Tailscale**:
   ```bash
   sudo tailscale up
   ```

3. **Start DeCloud** — it auto-detects Tailscale and uses Serve (tailnet-only):
   ```bash
   ./decloud start
   ```

Your URL: `https://your-machine-name.tail1234.ts.net` (reachable only from devices on your tailnet)

## Why Tailscale Serve (not Funnel)?

- **Private by default** — only devices on your tailnet can reach it. No public internet exposure.
- **Permanent URL** — never changes, bookmark it
- **End-to-end encrypted** — WireGuard + TLS 1.3
- **No account needed** — uses your existing Tailscale
- **Free** — 100 devices on free tier
- **Works on any network** — no port forwarding

DeCloud is **tailnet-only by design** — there is no public Funnel mode. If you want public access, use a Cloudflare Named Tunnel (below) and put your own auth in front of it.

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
6. Start: `cloudflared tunnel run`

## Private-Only Mode (No Tunnel At All)

If you don't want any tunnel:

1. Don't run `./decloud start` (skip tunnel)
2. Access via Tailscale directly: `http://your-machine:8899`
3. Friends/family need Tailscale app + your approval to join tailnet

## Troubleshooting

**"Serve failed"**
- Check Tailscale is running: `tailscale status`
- Check serve is enabled: `tailscale serve status`
- Restart: `./decloud restart`

**"URL not working"**
- Wait 30 seconds for DNS propagation
- Check: `curl -I https://your-machine.tail1234.ts.net`
- Regenerate QR: `./decloud qr`

**"Friends can't access"**
- Make sure they're on your tailnet (Tailscale installed + approved)
- Check your passcode is correct
- Verify serve is on: `tailscale serve status`
