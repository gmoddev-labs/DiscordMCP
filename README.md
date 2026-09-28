# Discord Control Plane

A deterministic Discord administration service for Codex and other MCP clients. It provides the same operations through local MCP stdio, authenticated loopback MCP HTTP, and a small JSON HTTP API. It does not use an LLM inside the bot.

## Current scope

- Discover bot guilds and inspect permissions, role hierarchy, and structural snapshots.
- List members with Discord's 1,000-member pagination. This requires the privileged Guild Members intent enabled for the application.
- List channels with `none`, `active`, or `allAccessible` thread scope. Archived threads are paginated per parent; omissions are reported.
- Adopt an existing role/channel by exact ID into a guild-local semantic key mapping.
- Plan, apply, and verify role/channel blueprints in `RECONCILE` or `REPLACE` mode. Optional pruning deletes unmanaged resources; replace deletes mutable channels and roles before creation.
- Plan focused role/channel create, update, or delete operations by exact ID. `PlanWipeChannels` and `PlanWipeRoles` produce reviewable deletion plans. Reorder editable roles by exact IDs.
- Add/remove one member role, kick one member, or ban one member with exact IDs and hierarchy preflight.

The structural control plane also has a personal assistant foundation. It records normalized gateway event metadata, reads bounded message and Discord audit-log pages, and stores operator notifications. AutoMod, onboarding, message mutations, webhooks, invites, emoji, stickers, workflows, and moderation cases are not implemented. A snapshot explicitly reports channel/thread/member completeness rather than claiming full coverage. Webhook tokens and bot credentials never enter snapshots or plans.

## Setup

1. Create a Discord application and bot. Enable **Server Members Intent** if member listing is needed. Invite the bot with Administrator for blueprint operations and place its role above roles it should manage. Discord still enforces role hierarchy.
2. Run `npm ci` and `npm run build`.
3. Copy `.env.example` to `.env`, enter `DISCORD_BOT_TOKEN`, and choose a random `CONTROL_API_TOKEN` of at least 24 characters for HTTP mode. Keep `.env` private.
4. Start local MCP with `node --env-file=.env dist/main.js --stdio`, or start the loopback HTTP service with `node --env-file=.env dist/main.js`.

The HTTP service binds to `127.0.0.1:8787` by default. It rejects non-loopback binding, checks Host and Origin, and requires `Authorization: Bearer <CONTROL_API_TOKEN>` on `/mcp` and `/v1/call`. `/health` is unauthenticated. Set `CONTROL_ACTOR` to identify the operator in plans and Discord audit log reasons. Stdio trusts the local launching process and uses the same actor setting.

`CONTROL_EVENT_RETENTION_DAYS` defaults to 30 (allowed range 1–365). Expired gateway events are removed at startup and after every 100 observed events. Event records contain IDs, type, and timestamp; message content is never stored in the event table. Set `CONTROL_MEMBER_EVENTS=true` only if the bot has the privileged Server Members intent enabled. `CONTROL_DISCORD_OPERATOR_IDS` accepts comma-separated Discord user IDs for future Discord-side interfaces; no Discord slash commands are registered yet.

Local MCP and authenticated local HTTP requests have distinct actor identities in plan and action audit state. Discord user identities are denied by default unless explicitly configured. The assistant capability policy is deterministic; structural changes still use the existing plan/apply/verify path.

### Assistant reads

`GetMessage`, `GetRecentMessages`, and `GetAuditEvents` fetch exact Discord resources. Message pages are limited to 100 items and audit pages to 100, each with a `before` cursor. `GetRecentActivity` reads locally observed gateway events with a maximum of 200 records per page and a sequence cursor. `GetOperatorBrief` combines one bounded activity page with unacknowledged notifications and states its coverage limits. `CreateNotification`, `GetNotifications`, and `AcknowledgeNotification` manage the local operator inbox. MCP also exposes `discord://guilds`, `discord://guild/{guildId}/activity`, and `discord://guild/{guildId}/notifications` resources.

These reads do not claim historical completeness for periods when the local service was offline. Reading message content requires Discord channel access and `Read Message History`; the service does not persist fetched message bodies. Discord audit reads require `View Audit Log`.

The SQLite schema uses ordered `user_version` migrations. Existing control databases are upgraded in place and retain their plan and mapping records. Back up `data/control.db` before an operator-initiated migration if its audit history matters.

### HTTP example

`POST http://127.0.0.1:8787/v1/call` with a bearer token and JSON:

```json
{"method":"GetActiveServers","params":{}}
```

All tool names in `src/interface.ts` are available through this endpoint and MCP. Every mutation names an exact guild ID or refers to a plan already bound to one. There is no process-global selected guild.

## Blueprint example

```json
{
  "version": 1,
  "roles": [
    {"key":"developer","name":"Developer","permissions":["VIEW_CHANNEL","SEND_MESSAGES"]}
  ],
  "channels": [
    {"key":"development","name":"DEVELOPMENT","type":"category"},
    {"key":"dev-chat","name":"dev-chat","type":"text","parent":"development",
      "overwrites":[{"target":"developer","allow":["VIEW_CHANNEL","SEND_MESSAGES"],"deny":[]}]}
  ],
  "policy": {"pruneChannels":false,"pruneRoles":false}
}
```

Call `PlanServer` with `guildId`, `blueprint`, and `mode: "RECONCILE"`; inspect its operations; call `ApplyPlan` with its `planId`; then call `VerifyServer`. The executor also verifies before marking a plan successful. Use `REPLACE` only for a complete structural rebuild. Community Rules/Updates channels stop replacement until a dedicated reconfiguration path exists.

Semantic keys map to exact Discord IDs in SQLite. Reconciliation never adopts an existing resource by name. If a matching name exists without a mapping, call `AdoptResource` with the exact ID first. A plan records the affected resources' pre-state; changed resources cause `PLAN_STALE`. Completed operations and created IDs are stored after each mutation. If an operation is left `running` after an interruption or network uncertainty, the plan is marked uncertain and requires inspection; it is never blindly replayed.

Managed channel overwrites are exact desired state: an empty `overwrites` array clears existing overwrites, and unspecified grants are removed. A matching blueprint produces zero update operations. Destructive plans also bind to the channel/editable-role ID sets so resources added between planning and application cause `PLAN_STALE` before mutation. Ordinary message activity does not invalidate these structural checks.

Failed and interrupted plans are terminal. Inspect Discord and the plan with `VerifyServer`, then use `AbandonPlan` and create a fresh plan. An ambiguous direct action records its action ID in the error; `GetUncertainActions` lists unresolved actions. After checking the outcome in Discord, call `ResolveUncertainAction` to release that guild's mutation hold. This acknowledgment does not replay the action.

SQLite is stored at `./data/control.db` by default, with WAL enabled. Back up this database if you need to preserve semantic mappings and execution records. The HTTP service is intentionally single-node and loopback-only.

## Development

Run `npm run build` and `npm test`. GitHub Actions runs `npm ci`, build, and tests on pushes and pull requests. Tests use a fake Discord adapter and a local HTTP listener; live Discord integration requires a configured bot and a test guild.
