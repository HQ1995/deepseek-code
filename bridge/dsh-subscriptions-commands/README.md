# @hqzhao95/dsh-subscriptions-commands

Terminal commands for [dsh-plugin-subscriptions](https://github.com/V1ki/dsh-plugin-subscriptions):
`/login`, `/logout`, `/code`, `/subscriptions-status`, registered through the
dsh command registry so any command-capable surface (dscode, other
terminals) gets subscription OAuth logins — no web profile needed.

```sh
dsh plugin --profile <profile> add dsh-plugin-subscriptions @hqzhao95/dsh-subscriptions-commands
```

In dscode: `/dsh add dsh-plugin-subscriptions @hqzhao95/dsh-subscriptions-commands`,
restart, then `/login codex` (or `claude` / `grok`). Same machine: the
browser redirect completes the login automatically. Remote/SSH: paste the
callback with `/code <url>`.

This package is a plugin-space adapter (the subscriptions plugin ships only
a web login UI; its OAuth engine is UI-agnostic). Pinned against
dsh-plugin-subscriptions 0.3.x internals.

> Personal project — not affiliated with DeepSeek, xAI, OpenAI, or Anthropic;
> names appear only to describe the components involved.

License: Apache-2.0.
