# Telegram channel cron delivery checklist

Use this when Panda asks a scheduled job to post into a Telegram channel or gives a `https://t.me/<channel>` URL.

## Problem shape

Hermes cron delivery targets are not the same as public Telegram URLs. A target like:

```text
telegram:@pdzeng_talk
```

can be accepted into the job config but fail at delivery with:

```text
Telegram send failed: invalid literal for int() with base 10: '@pdzeng_talk'
```

For Telegram channels, use the numeric channel chat ID, usually shaped like `-100...`:

```text
telegram:-1001176053097
```

## Procedure

1. Resolve the channel username to a numeric chat ID with the Telegram Bot API `getChat` endpoint using the active bot token. Do not print the token.
2. Update the cron job's `deliver` field to `telegram:<numeric_channel_id>`.
3. Send a one-line test message to the same numeric target before claiming success.
4. If the test fails with:

```text
Forbidden: bot is not a member of the channel chat
```

then the config is structurally correct but permissions are missing. Tell Panda to add the active bot to the channel, normally as an admin if it needs to post in a channel.
5. Re-test after Panda adds the bot or grants posting permission.

## Notes

- `send_message(action='list')` may only show known chats/topics from Hermes' channel directory. A public channel URL may be resolvable by the Telegram Bot API but absent from the directory until the bot is added or the channel has interacted with the gateway.
- Do not claim channel delivery is working just because the cron job was updated. Delivery must be tested.
- Keep the numeric target in the job after resolving it, even if the first test fails due to missing membership/admin rights.
