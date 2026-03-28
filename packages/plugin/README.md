# openclaw-channel-linear

Linear channel plugin for OpenClaw.

This package is the local OpenClaw side of the OpenClaw Linear bridge. It connects
your local OpenClaw runtime to a deployed Cloudflare gateway, receives Linear
`AgentSessionEvent` traffic over WebSocket, runs local OpenClaw sessions, and sends
activity updates back to Linear.

## Before You Install

This plugin expects the gateway side to already exist.

You should complete these steps first:

1. Deploy the Cloudflare gateway
2. Create a Linear application
3. Configure gateway secrets
4. Complete Linear OAuth authorization

The full setup guide lives here:

- [Repository README](https://github.com/TwoSX/openclaw-linear#readme)
- [简体中文 README](https://github.com/TwoSX/openclaw-linear/blob/main/README.zh-CN.md)

## Install

Install the plugin into OpenClaw:

```bash
openclaw plugins install openclaw-channel-linear
openclaw gateway restart
```

## Configure `channels.linear`

After OAuth succeeds, the gateway will show a ready-to-copy `channels.linear`
configuration snippet. At minimum, your OpenClaw config should contain:

```json
{
  "channels": {
    "linear": {
      "enabled": true,
      "gatewayBaseUrl": "https://<your-worker-domain>",
      "clientAuthToken": "CLIENT_AUTH_TOKEN",
      "healthMonitor": {
        "enabled": false
      }
    }
  }
}
```

Restart OpenClaw after updating the configuration:

```bash
openclaw gateway restart
```

Required fields:

- `gatewayBaseUrl`
- `clientAuthToken`

Optional fields:

- `promptContextTemplate`
- `debugTranscriptTrace`

Or configure it from the CLI:

```bash
openclaw config set channels.linear.enabled true --strict-json
openclaw config set channels.linear.gatewayBaseUrl '"https://<your-worker-domain>"' --strict-json
openclaw config set channels.linear.clientAuthToken '"<same-as-CLIENT_AUTH_TOKEN>"' --strict-json
openclaw config set channels.linear.healthMonitor.enabled false --strict-json
openclaw gateway restart
```

## Optional: `promptContextTemplate`

`promptContextTemplate` customizes the initial context passed to OpenClaw when a
Linear `AgentSession` starts.

Supported variable:

- `$issueContext`

Example:

```json
{
  "channels": {
    "linear": {
      "enabled": true,
      "gatewayBaseUrl": "https://<your-worker-domain>",
      "clientAuthToken": "<same-as-CLIENT_AUTH_TOKEN>",
      "promptContextTemplate": "You are handling a Linear agent session.\n\nBelow is the initial task context provided by Linear. Treat it as the primary context for this task.\nPrioritize actions based on the current issue context. If information is missing, ask concise questions first and do not invent facts.\n\n<linear_prompt_context>\n$issueContext\n</linear_prompt_context>",
      "healthMonitor": {
        "enabled": false
      }
    }
  }
}
```

If `$issueContext` is missing from the template, the original context is appended automatically.

## MCP

The gateway also exposes:

- `GET|POST|OPTIONS /linear/mcp`

This proxies the official Linear MCP endpoint using the active installation token.
See the repository README for the recommended `mcporter`-based setup.

## Compatibility

Tested with:

- `openclaw@2026.3.24`

Current runtime identity:

- plugin id: `linear`
- channel id: `linear`

## Notes

- The package name is `openclaw-channel-linear`, but the OpenClaw runtime id remains `linear`.
- On current OpenClaw releases, this package name can produce a non-blocking
  `plugin id mismatch` diagnostic. Runtime loading still works.

## Resources

- [OpenClaw: Building Plugins](https://docs.openclaw.ai/plugins/building-plugins)
- [OpenClaw: SDK Channel Plugins](https://docs.openclaw.ai/plugins/sdk-channel-plugins)
- [Linear OAuth 2.0 Authentication](https://linear.app/developers/oauth-2-0-authentication)
- [Linear Agent Interaction](https://linear.app/developers/agent-interaction)

## License

[MIT](./LICENSE)
