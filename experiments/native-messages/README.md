# Native DeepSeek Messages candidate

Apply `cordis.patch.yml` after the dscode bundle in an isolated DSH_HOME. Set
`DSCODE_NATIVE_DEEPSEEK_API_KEY` in the launcher environment (or configure that
credential reference through DSH). Choose a model on the `deepseek-official`
route in the existing model picker. No default model is changed and pi-ai routes
remain available.

`DSCODE_NATIVE_DEEPSEEK_BASE_URL` must be a Messages-compatible root; the adapter
appends `/v1/messages` and `/v1/files`; a root that already ends in `/v1` is
reused, not doubled. It does not translate a Chat endpoint; DSH 0.1.7 rejects a URL with credentials, a query
or a fragment. The default is `https://api.deepseek.com/anthropic`. Messages is
the adapter's only protocol in 0.1.7, so the overlay no longer names one.
The base bundle's `deepseek-account` service, when signed in, sends its account
token instead of the API key for the endpoint it covers; the isolated profile
home must not be signed in. Do not copy keys into YAML or reports. Raw session-log and package-inventory
contributions remain off.

Files reuse is for image request bytes, not arbitrary PDF/Office understanding.
File ids are credential/endpoint scoped; expiry or upload failure may trigger
inline fallback and permanent oldest-image offload. The TUI system notice
explains how to reintroduce an image. Generic `anthropic-messages` pi-ai routes
are not this native implementation.
