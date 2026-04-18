# Cloudflare Worker Dispatcher

This Worker triggers the GitHub Actions workflow that updates Hyperliquid market data.

## Secret

- `GITHUB_TOKEN`: fine-grained GitHub token with Actions write access to `harunamitrader/weekend_monitor_hyperliquid`

## Cron

- `*/5 * * * *`

## Files

- `worker.mjs`: Worker source for Cloudflare's editor or Wrangler
