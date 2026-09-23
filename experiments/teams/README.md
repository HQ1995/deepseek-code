# Teams candidate

Use a **fresh, dedicated DSH_HOME**, install the matching alpha dscode bundle,
then add this local bundle through `dsh plugin --profile dscode add <package>`.
The underlying Team packages must come from the same runtime closure, not duplicate SDK instances.
Launch dscode with that DSH_HOME. The only mode is Teams; ordinary tasks still
must not create teammates without an explicit user request.

The native host owns the roster, mailbox, task revision checks, persistence and
continuation lifecycle. `presets/teams.patch.yml` declares the `teams` preset
row: dscode's history composition without legacy delegation, workflows and
Ralph, so there are no same-name tools or one-shot children misclassified as
Team Leads. `cordis.patch.yml` mounts the Team rows under the ids upstream's
`dsh-experimental-agent-team-profile` uses, makes `teams` the registry default
and disables the other dscode preset rows. Normal dscode profiles are unchanged.
Eight lifetime roster slots, 256 tasks, 64 pending messages/member, 64 KiB/message.
Members are addressed by name; the model-facing views carry no session ids.

All members share a checkout. Write scopes are advisory, not locks; no worktree
creation or automatic conflict resolution is promised. Accepted/queued messages
must not be resent. A disconnected client must re-read durable state. Keep this
bundle installed when reopening its sessions; removing it is not a migration.
