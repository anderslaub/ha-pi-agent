# Pi Agent for Home Assistant

Use [pi](https://pi.dev), the coding agent harness, as a Home Assistant **conversation agent**. Pi runs on
your own machine with your own setup: model, `AGENTS.md`, skills, extensions and packages (web search,
memory, sub-agents and so on). You can talk to it from any Assist voice satellite or from the Assist chat.

It's meant for a second voice pipeline next to Home Assistant's own intent pipeline. Quick commands
("turn off the kitchen light") go to HA's intents. Long conversations, research, knowledge questions and
coding tasks go to pi.

```
 voice satellite ──► HA Assist pipeline ──► Pi Agent (conversation entity)
                                                │  HTTP, streaming NDJSON
                                                ▼
                     va-bridge: a pi extension (/va-bridge) or a headless service ──► pi sessions
```

The repository is two things at once: a HACS integration (`custom_components/pi_agent`) and a pi package
(va-bridge, in `bridge/`). Pi is the assistant's brain; the voice, if any, is HA's STT and TTS.

## Features

- **Real pi sessions.** Each conversation is a normal pi session saved to disk, so you can resume it at
  the keyboard with `pi -r`.
- **Streaming.** Spoken text streams into Home Assistant as it's generated, so streaming TTS starts
  talking right away. Tool use shows up as "thinking" in the Assist debug view and isn't spoken.
- **Speech-friendly.** Pi is told it's speaking. Markdown, code blocks, tables and URLs are stripped
  before the text reaches TTS.
- **Long tasks run in the background.** If pi is still working after the *reply budget*
  (default 15 s):
  1. The satellite says "I'm on it. I'll let you know when it's done."
  2. Pi keeps working.
  3. The final answer is **announced on the same satellite** when it's ready. With no satellite, it
     becomes a persistent notification.
  4. A `pi_agent_task_finished` event fires for automations.
- **Follow-up questions keep the mic open.** A reply ending in "?" continues the conversation, like
  other LLM agents.
- **Conversation memory, your choice:**
  - a new pi session for each conversation, or
  - one ongoing session per device that resets after a quiet period ("what did we talk about
    this morning?").
- **Busy handling.** Talk to it while a background task is running and your request is queued as a
  follow-up.

## Install

### 1. The bridge (a pi package, on the machine where pi is installed)

```sh
pi install git:github.com/anderslaub/ha-pi-agent
```

Then, in pi:

```
/va-bridge setup          creates ~/.pi/agent/va-bridge.json with a token and shows what to enter in HA
/va-bridge start          starts the bridge inside this pi (the footer shows "va-bridge :8787")
/va-bridge autostart on   start it whenever an interactive pi starts
/va-bridge prompt         write the system prompt to ~/.pi/agent/va-bridge/SYSTEM.md for editing
/va-bridge                status: URL, working directory, model, sessions, prompt file
```

Assistant sessions run in that pi process next to your own session, as separate pi sessions in their own
working directory (default `~/pi-va`). The bridge stops when that pi exits. If several pi instances have
autostart on, the first one serves and the others leave it alone.

**Always on, without an interactive pi:** run the same bridge headless as a service:
`node ~/.pi/agent/git/github.com/anderslaub/ha-pi-agent/bridge/src/cli.ts` (Node.js 24+). For a systemd user
unit, see `bridge/systemd/pi-va-bridge.service`. It uses the same settings file.

### 1b. Or: Docker

`docker/` has a Dockerfile, which installs pi and the va-bridge package, and a `compose.yaml`:

```sh
cd docker
cp .env.example .env      # PI_BRIDGE_TOKEN, model, provider key, PUID/PGID, WORKSPACE
cp SYSTEM.md.example SYSTEM.md   # the assistant's system prompt
docker compose up -d --build
```

- **Settings** come from environment variables (`PI_BRIDGE_*`, see below). Everything in `.env` is passed to
  the container, so put provider keys such as `ANTHROPIC_API_KEY` there. Keys from your shell are not passed
  through. Changes to `.env` apply with `docker compose up -d` (a restart does not re-read it).
- **pi inside the container:** `docker compose exec va-bridge pi` (or `docker exec -it pi-va-bridge pi`; the
  `-it` is needed for the interactive UI). It always runs as the container's user. Use it to `/login` to a
  provider, and `/model` to pick the default model; both are kept in the `pi-agent` volume. A shell:
  `docker compose exec -u node va-bridge bash`.
- **Model:** `PI_BRIDGE_MODEL` in `.env` (e.g. `anthropic/claude-sonnet-5-5`; list them with
  `docker compose exec va-bridge pi --list-models`), else the default picked with `/model`. The log and
  `/v1/health` show which model is used, and warn when pi has no usable model yet.
- **Local llama.cpp** (router mode): set `LLAMA_BASE_URL` (and `LLAMA_API_KEY` if the router has one) in
  `.env`. For a router on the Docker host use `http://host.docker.internal:<port>`, since `localhost` is the
  container itself, and make sure the router listens on an address the container can reach, not only
  127.0.0.1. Pick a model with `PI_BRIDGE_MODEL=llama.cpp/<model id>`. Only models the router has loaded
  (or can autoload) are listed.
- **Router not reachable** (`ConnectTimeoutError` to `host.docker.internal`): a timeout usually means the
  host's firewall drops traffic from Docker networks (ufw, firewalld). Allow the router's port from them,
  e.g. `sudo ufw allow from 172.16.0.0/12 to any port <port> proto tcp`. Or put the container on the host's
  network and use `LLAMA_BASE_URL=http://127.0.0.1:<port>`; the bridge is then on the host's port 8787:
  `compose.override.yaml` with `services: {va-bridge: {network_mode: host, ports: !reset [], extra_hosts: !reset []}}`. A refused
  connection instead means the router only listens on 127.0.0.1. Test from inside the container:
  `docker compose exec va-bridge curl -sv -m 5 http://host.docker.internal:<port>/health`.
- **Is it up?** `curl -H "Authorization: Bearer $PI_BRIDGE_TOKEN" http://localhost:8787/v1/health`, and
  `docker compose logs -f` for what it is doing. `PI_BRIDGE_PORT` in `.env` is the port on the host.
- **Working folder:** `WORKSPACE` (default `docker/workspace`) is mounted as `/workspace`.
- **System prompt:** `docker/SYSTEM.md` (yours, git-ignored) is mounted read-only as the assistant's prompt,
  `/workspace/.pi/va-bridge/SYSTEM.md`. It is read for every new conversation, so edits apply without a
  restart. Some editors save by replacing the file, which a running container does not see; then run
  `docker compose restart`. Compose refuses to start until the file exists.
- **Local compose changes** (ports, extra volumes) go in `docker/compose.override.yaml` (git-ignored); docker
  compose merges it automatically.
- **pi's state** (logins, settings, packages, session history) is kept in the `pi-agent` volume.
- **Packages:** `PI_PACKAGES="npm:pi-web-access …"` installs extra pi packages on first start. npm 12 skips
  install scripts (postinstall) of packages it is not told to trust: those in `PI_PACKAGES` are trusted, and
  `PI_ALLOW_SCRIPTS` (comma separated) adds others, such as dependencies that need a build step.
- **Ownership:** the container runs as your host user (`PUID`/`PGID`), so files it writes are yours.
- **Updates:** the image uses the latest pi, npm and Debian updates at build time, not pinned versions.
  Docker caches those layers, so to update run `docker compose build --pull --no-cache && docker compose up -d`.
  To pin pi, set `PI_VERSION=0.85.1` (for example) in `.env`.

### 2. The integration

**HACS:** [![Open in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=anderslaub&repository=ha-pi-agent&category=integration)

Or by hand: HACS → ⋮ → *Custom repositories* → `https://github.com/anderslaub/ha-pi-agent`, type
*Integration* → *Add*. Then open **Pi Agent** in HACS, *Download*, and restart Home Assistant.

**Manual:** copy `custom_components/pi_agent` into `<config>/custom_components/` and restart.

Then go to **Settings → Devices & services → Add integration → Pi Agent**
([![Add integration](https://my.home-assistant.io/badges/config_flow_start.svg)](https://my.home-assistant.io/redirect/config_flow_start/?domain=pi_agent))
and enter the bridge URL
(e.g. `http://192.168.1.20:8787`) and the token.

### 3. A second wake word for pi

1. Create an assistant under **Settings → Voice assistants** that uses **Pi Agent** as the
   conversation agent.
2. Voice satellites that support two wake words show **Wake word 2** and **Assistant 2** settings.
   Examples are ESPHome devices with two non-internal microWakeWord models, such as Voice PE.
3. Point wake word 2 at, say, "Okay Nabu", and assistant 2 at the pi assistant.

Home Assistant then runs the pi pipeline only when that wake word is heard.

## Options

| Option | Default | |
|---|---|---|
| Extra instructions | – | Added to pi's system prompt; templates allowed |
| Reply budget | 15 s | After this long, the task continues in the background |
| Conversation memory | per conversation | Or one ongoing session per device |
| Start a fresh session after | 4 h | Per-device mode only |
| Announce results of long tasks | on | Spoken in the voice of the assistant that uses pi. Off = only the event and notification |
| Debug mode | off | Logs every text to and from pi (heard, replies, tool calls, background results) in the HA log and the logbook |
| Background / busy / failed messages | English | Change them if your assistant speaks another language. In the failed message, `{error}` is replaced by the reason |
| Working directory | bridge default | Where pi starts (its project `AGENTS.md`, `.pi/` apply) |

### Showing that pi is working (ESPHome satellites)

When a task continues in the background, the integration fires `pi_agent_task_started`, and later
`pi_agent_task_finished`. If the satellite is an ESPHome device whose firmware defines an API action
`pi_agent_working` (one `bool` variable, `working`), it calls that action with `true`, and with `false`
before the result is announced. The device can then show a "working" state instead of waiting for an
answer. Every 3 minutes the integration asks the bridge whether each task is still running; a task that
finished without its result arriving, or that the bridge no longer knows, is announced from there (the
failed message), so a satellite never stays in "working":

```yaml
api:
  actions:
    - action: pi_agent_working
      variables:
        working: bool
      then:
        - lambda: ESP_LOGI("pi", "working: %d", working);
```

The same way, a `pi_agent_loading` action (one `bool` variable, `loading`) is called on every ESPHome device
that defines it while the assistant starts up: the model is loading on the llama.cpp router, the bridge is
warming up, or the bridge cannot be reached. It is repeated every 10 s while loading, and called once with
`false` when the assistant is ready, so a device can show a "loading" state and end it by itself when the
refreshes stop.

### Bridge settings

`~/.pi/agent/va-bridge.json`, or the `PI_BRIDGE_*` environment variable (which wins):

| Key | Variable | Default | |
|---|---|---|---|
| `token` | `PI_BRIDGE_TOKEN` | made by `/va-bridge setup` | Shared secret (≥ 16 chars) |
| `host` / `port` | `PI_BRIDGE_HOST` / `PI_BRIDGE_PORT` | `0.0.0.0` / `8787` | Where to listen |
| `cwd` | `PI_BRIDGE_CWD` | `~/pi-va` | Working directory of assistant sessions |
| `model` | `PI_BRIDGE_MODEL` | pi default | e.g. `anthropic/claude-sonnet-5-5:low` or `llama.cpp/<model id>`; a fast model suits voice use |
| `thinking` | `PI_BRIDGE_THINKING` | pi default | `off`/`minimal`/`low`/… ; lower = faster replies |
| `tools` | `PI_BRIDGE_TOOLS` | pi default | List (or comma string) to restrict tools |
| `idleMinutes` | `PI_BRIDGE_IDLE_MINUTES` | 120 | Unload idle sessions from memory |
| `budgetSeconds` | `PI_BRIDGE_BUDGET_S` | 15 | Reply budget when HA sends none |
| `taskTimeoutMinutes` | `PI_BRIDGE_TASK_TIMEOUT_MIN` | 10 | A background task running longer is stopped and reported as failed |
| `warmup` | `PI_BRIDGE_WARMUP` | true | One throwaway turn at startup (same prompt and tools as the last real turn), so the model server has the long prompt cached before the first question |
| `autostart` | `PI_BRIDGE_AUTOSTART` | false | Start with interactive pi |
| – | `HA_TOKEN` | – | Docker: a Home Assistant long-lived access token, for an MCP server entry in pi's `~/.pi/agent/mcp.json` (`"headers": {"Authorization": "Bearer ${HA_TOKEN}"}`), so the token stays out of prompts |

### System prompt

The assistant gets its own system prompt, which **replaces** pi's default coding-agent prompt (and pi's own
`SYSTEM.md`, which is meant for your coding sessions). It is the first of these files that exists, otherwise a
built-in default (plain sentences that work spoken or as text, keep it short, no markdown):

1. `<bridge cwd>/.pi/va-bridge/SYSTEM.md`: only sessions in that working directory
2. `~/.pi/agent/va-bridge/SYSTEM.md`: all sessions of the bridge

`/va-bridge prompt` writes the built-in default to the second location as a starting point. Because these
files live in a `va-bridge/` folder, they never affect your normal pi sessions.

Everything pi adds around its base prompt stays: the list of available tools with their guidelines,
`APPEND_SYSTEM.md`, `AGENTS.md` context files, skills and the working directory. The assistant's language and
the *Extra instructions* from the HA options are appended to your prompt. The bridge loads the working
directory's `.pi/` without asking about project trust, so only point it at folders you control. Files are
re-read for every new session, so no restart is needed.

## Security

**Anyone who can talk to your voice satellites can make pi run commands on the bridge host**, because
pi's default tools include `bash`, `edit` and `write`. Before you connect it:

- **Contain it:** run the bridge as a dedicated user or in a container (see pi's `containerization.md`).
- **Limit the tools** with `PI_BRIDGE_TOOLS` (e.g. `read,grep,find,ls` plus your web search tool), or
  limit what they can reach with a project `.pi/` config.
- **Protect the token:** keep it long and random, and the bridge on your LAN. The HTTP API isn't
  encrypted, so put it behind a TLS reverse proxy if it crosses untrusted networks.

## Bridge API

All requests need `Authorization: Bearer <token>`.

- `GET /v1/health` returns `{ok, ready, loading?, bridge_version, pi_version, mode, model, models_available, warning?, cwd, assistant_prompt, sessions, last_event_id}`.
- `POST /v1/turn` takes `{text, session_key, language, conversation_id, device_id, satellite_id,
  instructions, budget_s, reset_after_s, cwd, detach_message, busy_message}`. It streams NDJSON lines:
  - `{"t":"text","d":…}`: speech-ready text
  - `{"t":"activity","d":"bash: ls"}`
  - `{"t":"detached","task_id":…,"d":…}`
  - `{"t":"error","message":…}`
  - `{"t":"done"}`
- `POST /v1/abort` takes `{session_key}`.
- `GET /v1/tasks/<task_id>` returns `{task_id, state: running|done|failed, seconds, tool?, text?, error?}` (404 if unknown).
- `GET /v1/events?since=<id>` streams NDJSON `task_done` / `task_failed` events (with
  `satellite_id`, `text`, `error`) and pings every 15 s.

## Development

```sh
uv venv && uv pip install -r requirements_test.txt
.venv/bin/pytest                      # integration tests (fake bridge over real HTTP)
npm install && npm test               # bridge tests (speech filter, settings, prompt files)
pi -e .                               # try the extension from this checkout, then /va-bridge start
# end-to-end against a running bridge + pi:
PI_BRIDGE_URL=http://127.0.0.1:8787 PI_BRIDGE_TOKEN=... .venv/bin/pytest tests/test_live_bridge.py
```

Your own setup files are git-ignored, so `git pull` never conflicts with them: `docker/.env` (from
`.env.example`), `docker/SYSTEM.md` (from `SYSTEM.md.example`), `docker/compose.override.yaml` and
`docker/workspace/`.
