# DiscordMCP Invariants

This is the operating contract for DiscordMCP. Keep this document aligned with the code whenever behavior, permissions, storage, or supported operations change. The [README](../README.md) is the short setup guide; this file records the strict rules and current limits.

## Authority and scope

- The service has no built-in AI model. An MCP client or authenticated local HTTP caller chooses tool calls; the service validates and executes them. Treat client instructions and generated plans as untrusted until reviewed.
- Every guild operation must name an exact Discord guild ID, or use a saved plan already bound to one. Never introduce a process-wide selected guild or infer a guild from a resource name.
- Keep local MCP and local HTTP actor identities distinct in saved plans and action records. Only the actor that owns a plan or uncertain action may apply, abandon, or resolve it.
- The current authorization policy trusts the local MCP process and anyone holding the local HTTP bearer token with all capabilities. Configured Discord operator IDs are allowed; other Discord user identities are denied. Capability names exist, but they are **not** fine-grained grants for trusted local callers. Do not describe this as per-tool least privilege.
- HTTP mode must remain bound to loopback (`127.0.0.1` or `::1`), validate Host and Origin, and require a bearer token of at least 24 characters for `/mcp` and `/v1/call`. `/health` is unauthenticated. Do not expose this service directly to a network or place tokens in logs, plans, snapshots, or source control.
- Discord's own permissions and role hierarchy still apply. Structural planning currently requires the bot to have Administrator. Member role changes require Manage Roles and a role below the bot; kicks and bans require their matching permissions and a target below the bot. The guild owner cannot be moderated.
- Nickname, timeout, and voice-member operations require their corresponding Discord permissions and an exact member. Nickname and timeout changes check role hierarchy; timeout also rejects the guild owner and administrators and is limited to 28 days. Discord may still reject a mutation after preflight if permissions or member state change.

## Structural change workflow

1. Inspect `GetActiveServers`, `GetCapabilities`, and a fresh `GetServerSnapshot` for the **exact** guild. Read the snapshot's completeness and omissions before treating it as a full inventory.
2. Prefer `RECONCILE` plans. Existing roles and channels must be adopted by exact Discord ID with `AdoptResource` before a semantic key can manage them. Matching names alone never authorize adoption.
3. Create a plan with `PlanServer` or `PlanResourceMutation`. Inspect its guild ID, actor, mode, every operation, target ID, and deletion/pruning policy before `ApplyPlan`. `PlanWipeChannels`, `PlanWipeRoles`, `REPLACE`, and pruning are destructive operations; never infer consent for them from a general request to organize a server.
4. Apply only the reviewed plan as its owning actor. Before execution, the service checks saved mappings and affected Discord state. A stale plan must be regenerated, not forced through. Operations are persisted as they run and the service verifies the result before marking the plan successful.
5. If a plan fails, is interrupted, or becomes uncertain, inspect Discord and `VerifyServer`. Do not blindly replay it. Use `AbandonPlan` only after inspection, then create a fresh plan. For an uncertain direct action, inspect its real Discord outcome, then use `ResolveUncertainAction`; resolution releases the guild hold and does not replay the action.

The service serializes mutations per guild and blocks new mutations while a running or uncertain plan or direct action owns that guild. Preserve this behavior when adding tools or changing storage.

## Destructive boundaries

- Never delete, prune, or replace a channel or role merely because its name differs from a blueprint. Resource identity is its exact Discord ID and saved guild-local mapping.
- `REPLACE` deletes mutable channels and roles before creating the desired structure. Channel pruning and replacement require a provably complete channel snapshot. Community Rules and Public Updates channels cannot be deleted by replacement or pruning until an explicit reconfiguration path exists.
- Channel snapshots do not include threads. Archived threads are read separately with `GetAllChannels(..., "allAccessible")`; that read can still report partial coverage. Treat archive-bearing channels and categories as protected during any real-world cleanup unless their contents and deletion consequences have been explicitly reviewed.
- Managed channel permission overwrites are exact desired state. Applying an empty overwrite list clears existing overwrites; omitted grants are removed. Review these changes as carefully as deletions.
- `SetChannelPositions` accepts at most one parent change per request. Permission syncing requires an actual move to a new category. Every referenced channel and destination category is checked against the exact guild before mutation.
- Version 1 blueprints may also reconcile supported guild settings, role Unicode emoji, and typed text, voice, stage, forum, and media channel settings. Guild channel references use semantic keys that resolve to exact saved mappings. Existing forum tags require exact tag IDs; the channel mutation path will not delete an existing tag by omission. New tags may be created without IDs. These settings participate in stale-plan checks and result verification.
- Direct member actions, including nickname, timeout, and voice control, do not use structural plans. Resolve the exact guild, member, and requested effect from the operator's instruction before calling them; do not guess a target. They perform preflight checks and record action IDs. An uncertain result must be inspected before another mutation is attempted.

## Reads, history, and storage

- A structural snapshot describes only what was fetched. It marks channels `complete` only when the bot has Administrator; otherwise they are `accessible_only`. Threads and messages are omitted from snapshots. Members are omitted unless requested, and a failed member fetch is partial, never complete.
- Member listing is paginated and needs Discord's Server Members intent. Gateway member events additionally require `CONTROL_MEMBER_EVENTS=true` and that intent. Do not claim member coverage when either is unavailable.
- Message and audit reads are bounded pages of at most 100 records and require Discord access to the exact resource. Message bodies are returned for requested reads but are not written to the event table. Do not turn a bounded page into a claim of full history.
- Message, reaction, thread, invite, and poll operations require exact guild and resource IDs. Channel-scoped calls verify channel ownership before acting. Direct mutations use the same serialized, recorded, uncertain-action workflow as member actions. Sends and edits suppress automatic mentions by default; explicit user, role, and everyone mention requests are bounded, and role IDs are verified against the guild. Messages can include typed embeds, link buttons, stickers, replies, and polls where supported. Message bodies are not persisted in action records.
- Permission explanation uses deterministic guild-role and channel-overwrite order. Thread channel permissions use parent overwrites. Private-thread membership and an unavailable thread parent produce partial confidence. Role audits are bounded, exclude multi-role combinations and member-specific overwrites, and must not be treated as a member-level access guarantee.
- The MCP surface defaults to `full`: registered direct operations plus four progressive discovery/dispatch tools. `CONTROL_MCP_SURFACE=progressive` exposes four structural planning/verification tools plus `SearchTools`, `ReadTool`, `WriteTool`, and `DestructiveTool`. Internal operation validation and authorization are the same in both modes. Risk labels route progressive calls; they are not separate grants for trusted local callers.
- Gateway activity is locally observed metadata only. It misses events while the service is offline and may miss events outside its access. Activity pages are capped at 200 records. Event retention defaults to 30 days and may be configured from 1 to 365 days; pruning runs at startup and after every 100 observed events.
- Operator notifications, plans, mappings, action state, and event metadata live in the SQLite database at `CONTROL_DB_PATH` (default `./data/control.db`). Migrations are ordered and in place. Back up that database before upgrades or recovery work when its history matters. Do not commit `.env`, tokens, `data/`, generated databases, or logs.

## Current limits

- This is a local single-node service. It is not a hosted multi-user control panel, and local caller authorization is broad.
- There are no Discord slash commands or autonomous AI decisions in this repository. `CONTROL_DISCORD_OPERATOR_IDS` defines possible Discord operators; it does not create a Discord-side interface.
- AutoMod, onboarding, webhook management, emoji assets, sticker management, workflows, moderation cases, multipart uploads, interactive component callbacks, and arbitrary message payloads are not implemented. Message components support link buttons only. Guild icon/banner and role icon mutations are deferred. Archived-thread inventory remains limited as described above.
- Membership-screening mutation is unavailable through the documented public API and remains externally blocked. Later slices may add AutoMod and onboarding, assets and webhooks, and application-platform tools. These are plans, not current capabilities.
- Discord rate limits, missing permissions, inaccessible archived threads, gateway downtime, and network uncertainty can leave reads incomplete or actions uncertain. Surface these limits to the operator instead of silently guessing or retrying a mutation.

## Change and release discipline

- Preserve exact-ID validation, actor ownership, guild isolation, permission and hierarchy checks, bounded reads, completeness labels, and fail-closed uncertain-action handling when changing code.
- Use PascalCase for new identifiers by default. Use `[System:SubSystem]` style for new logs. Report errors through the caller or logs; do not add disruptive desktop popups.
- Run `npm run build` and `npm test` for behavior changes. Tests should use fake Discord adapters or local listeners, not a live server. Review the diff for accidental secrets and update this document when an invariant or limitation changes.
