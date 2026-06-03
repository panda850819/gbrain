# Telegram channel cron delivery via n8n bot

Use when Panda asks a cron job to publish to a Telegram channel where the Hermes bot is not an admin, but an existing project/n8n bot is.

## Problem shape

Hermes cron `deliver` targets use Hermes' Telegram adapter. For Telegram channels:

- `telegram:@channel_username` can fail because Hermes delivery expects numeric chat IDs.
- `telegram:<numeric_channel_id>` can still fail with `Forbidden: bot is not a member of the channel chat` if the active Hermes bot is not a channel admin.
- Panda may already have a different bot, often project/n8n-specific, that can post to the channel.

## Proven pattern

1. Resolve the channel ID only if needed, but do not rely on Hermes delivery if the Hermes bot lacks channel permission.
2. Find the project that already posts to the target channel. For `@pdzeng_talk`, the durable precedent is:
   - `/Users/panda/site/trading/trump-stock-alert/main.py`
   - project `.env` contains `TELEGRAM_BOT_TOKEN` for `@n8n_panda_bot`
   - that bot is an admin of `@pdzeng_talk`
3. Set the Hermes cron job to `deliver: local`.
4. Keep the data-collection `script` if useful.
5. In the cron prompt, instruct the agent to send the final message itself through Telegram Bot API using the project/n8n bot token.
6. Never print or store the token in outputs. Read it inside the terminal command and post to `chat_id=@channel_username`.
7. Run a real test and verify the cron output includes a successful `message_id`.

## Minimal Bot API send shape

```python
import urllib.parse, urllib.request, json

data = urllib.parse.urlencode({
    'chat_id': '@pdzeng_talk',
    'text': message,
    'disable_web_page_preview': 'true',
}).encode()
req = urllib.request.Request(f'https://api.telegram.org/bot{token}/sendMessage', data=data)
with urllib.request.urlopen(req, timeout=20) as r:
    resp = json.loads(r.read())
assert resp.get('ok')
```

## Pitfalls

- Do not leave the job on `telegram:@username`; Hermes delivery may parse the target as an int and fail.
- Do not keep `deliver: telegram:<channel_id>` when the Hermes bot is not a member/admin. The failure is a channel permission mismatch, not a bad chat ID.
- Do not read from global `~/.hermes/.env` if the project has a dedicated bot token. Project `.env` can intentionally differ from Hermes' gateway bot token.
- Do not capture the transient missing-package failure as a durable rule. If the cron script runs under Hermes' venv, install the needed package in that venv or use a wrapper with the intended interpreter.
