# Agent config examples

| Client | File | Transport |
|---|---|---|
| Claude Desktop | `claude_desktop_config.json` | stdio bridge (`postlite mcp` with `POSTLITE_URL`) — lets Claude upload local files via `upload_media_from_path` |
| Claude Code | `claude-code.mcp.json` (project `.mcp.json`) or `claude mcp add --transport http postlite https://social.example.com/mcp --header "Authorization: Bearer $POSTLITE_API_KEY"` | Streamable HTTP |
| Cursor | `cursor.mcp.json` (`~/.cursor/mcp.json`) | Streamable HTTP |
| Hermes | `hermes-config.yaml` | Streamable HTTP or stdio |
| ChatGPT / others | Use the REST API + `https://social.example.com/api/v1/openapi.json` (e.g. as a GPT Action with Bearer auth) or any MCP-capable client | REST / MCP |

Create a key in **Settings → API keys** or on the server: `node bin/postlite.js keys create --name "Claude"`.
New keys are in **approval mode** by default: posts they schedule wait for you under **Approvals**.
