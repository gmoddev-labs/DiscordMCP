# DiscordMCP

## What This Is

DiscordMCP is a helper for looking after a Discord server. It lets an AI assistant check your server, help organize channels and roles, and handle a few moderation tasks. For bigger changes, it can show you a plan before applying it.

The bot does not have an AI model of its own. Your MCP client talks to it and decides what to ask it to do.

## How to Set Up

1. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications) and invite it to your server. Give it the permissions needed for the jobs you want it to do, and put its role above any roles it needs to manage. Enable **Server Members Intent** if you want to list members.
2. Install [Node.js](https://nodejs.org/), then run `npm ci` and `npm run build` in this folder.
3. Copy `.env.example` to `.env`. Add your bot token as `DISCORD_BOT_TOKEN`. Keep this file private.
4. Add this as a local MCP server in your AI client: `node --env-file=.env dist/main.js --stdio`. Run it from this folder so it can find `.env` and its data directory.

If you want to use the local HTTP service instead, set a random `CONTROL_API_TOKEN` of at least 24 characters in `.env` and run `node --env-file=.env dist/main.js`. It listens on your computer at `127.0.0.1:8787` by default.

### Want your AI assistant to help with setup?

You don't have to figure out every setup step yourself. If you're using an AI coding or desktop assistant that can work with local files and applications, you can ask it:

> **“Set up DiscordMCP for me and walk me through anything that requires my input.”**

Your assistant can help install dependencies, build the project, configure the MCP connection, and verify that it is working.

When Discord requires you to create a bot or provide a bot token, **follow the assistant's instructions and enter the token into the `.env` file yourself. Never paste your bot token into a public chat, repository, or source file.**

The assistant should also help you choose the Discord permissions you actually want to grant rather than automatically giving the bot more access than necessary.

For users who prefer manual setup, the steps below provide the complete process.


## AI Disclaimer

AI assistants can make mistakes. Read plans carefully before applying changes, especially when removing channels, roles, or members. Give the bot only the permissions you are comfortable with, and never share your bot token or `.env` file.

## MIT License

DiscordMCP is available under the MIT License. See [LICENSE](LICENSE).
