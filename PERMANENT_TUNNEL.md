# Permanent Tunnel Setup

DeCloud uses **Tailscale Funnel** for secure, permanent remote access. This gives you a URL like `https://your-machine.tail1234.ts.net` that never changes.

## Quick Setup (Recommended)

1. **Install Tailscale** (if not already):
   ```bash
   curl -fsSL https://tailscale.com/install.sh | sh
   ```

2. **Start Tailscale**:
   ```bash
   sudo tailscale up
   ```

3. **Start DeCloud** — it auto-detects Tailscale and uses Funnel:
   ```bash
   ./decloud start
   ```

Your URL: `https://your-machine-name.tail1234.ts.net`

## Why Tailscale Funnel?

- **Permanent URL** — never changes, bookmark it
- **End-to-end encrypted** — WireGuard + TLS 1.3
- **No account needed** — uses your existing Tailscale
- **Free** — 100 devices on free tier
- **Works on any network** — no port forwarding

## Sharing with Friends/Family

They **don't need Tailscale installed**. Just send them:
1. The URL: `https://your-machine.tail1234.ts.net`
2. Your DeCloud passcode

They can add it to their phone home screen like any app.

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

## Private-Only Mode (No Public URL)

If you don't want any public access:

1. Don't run `./decloud start` (skip tunnel)
2. Access via Tailscale directly: `http://your-machine:8899`
3. Friends/family need Tailscale app + your approval to join tailnet

## Troubleshooting

**"Funnel failed"**
- Check Tailscale is running: `tailscale status`
- Check funnel is enabled: `tailscale funnel status`
- Restart: `./decloud restart`

**"URL not working"**
- Wait 30 seconds for DNS propagation
- Check: `curl -I https://your-machine.tail1234.ts.net`
- Regenerate QR: `./decloud qr`

**"Friends can't access"**
- Make sure you gave them the full URL (including `https://`)
- Check your passcode is correct
- Verify funnel is on: `tailscale funnel status`
