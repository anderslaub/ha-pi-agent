"""Pi Agent: use the pi coding agent harness as a Home Assistant conversation agent."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import logging
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_API_TOKEN, CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import BridgeAuthError, BridgeError, PiBridgeClient
from . import debug
from .const import CONF_ANNOUNCE, CONF_FAILED_MESSAGE, DEFAULT_OPTIONS, DOMAIN, EVENT_TASK_FINISHED, TASK_CHECK_SECONDS
from .satellite import async_set_working, pi_pipeline, tts_media_id

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.CONVERSATION]


@dataclass
class PiAgentData:
    """Runtime data."""

    client: PiBridgeClient
    agent_entity_id: str | None = None
    # background tasks in progress: task_id -> who asked (satellite_id, device_id, conversation_id, ...)
    tasks: dict[str, dict[str, Any]] = field(default_factory=dict)
    # task ids whose result was delivered (by the event stream or the status check), so it is never announced twice
    delivered: list[str] = field(default_factory=list)


type PiAgentConfigEntry = ConfigEntry[PiAgentData]


async def async_setup_entry(hass: HomeAssistant, entry: PiAgentConfigEntry) -> bool:
    """Set up Pi Agent from a config entry."""
    client = PiBridgeClient(
        async_get_clientsession(hass), entry.data[CONF_URL], entry.data[CONF_API_TOKEN]
    )
    try:
        info = await client.health()
    except BridgeAuthError as err:
        raise ConfigEntryAuthFailed(str(err)) from err
    except BridgeError as err:
        raise ConfigEntryNotReady(str(err)) from err

    entry.runtime_data = PiAgentData(client=client)
    entry.async_create_background_task(
        hass,
        _async_listen_for_tasks(hass, entry, client, info.get("last_event_id")),
        f"{DOMAIN}_events_{entry.entry_id}",
    )
    entry.async_create_background_task(
        hass, _async_watch_tasks(hass, entry, client), f"{DOMAIN}_tasks_{entry.entry_id}"
    )
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: PiAgentConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


async def _async_listen_for_tasks(
    hass: HomeAssistant,
    entry: PiAgentConfigEntry,
    client: PiBridgeClient,
    last_id: int | None,
) -> None:
    """Follow the bridge's event stream and deliver results of background tasks."""
    backoff = 2
    while True:
        try:
            async for event in client.events(last_id):
                backoff = 2
                if (event_id := event.get("id")) is not None:
                    last_id = event_id
                elif last_id is None and "last_id" in event:
                    last_id = event["last_id"]
                if event.get("t") in ("task_done", "task_failed"):
                    hass.async_create_task(_async_deliver(hass, entry, event))
        except BridgeAuthError:
            _LOGGER.error("The pi bridge rejected the token; background results are not delivered")
            entry.async_start_reauth(hass)
            return
        except BridgeError as err:
            _LOGGER.debug("%s; reconnecting in %ss", err, backoff)
        await asyncio.sleep(backoff)
        backoff = min(backoff * 2, 60)


async def _async_watch_tasks(
    hass: HomeAssistant, entry: PiAgentConfigEntry, client: PiBridgeClient
) -> None:
    """Every few minutes, check the background tasks in progress. A task the bridge finished without the
    result reaching us (the event stream dropped), or one it no longer knows (it restarted), is delivered
    from here, so the satellite stops showing "working" and says what happened."""
    while True:
        await asyncio.sleep(TASK_CHECK_SECONDS)
        for task_id, meta in list(entry.runtime_data.tasks.items()):
            try:
                status = await client.task(task_id)
            except BridgeError as err:
                debug.log(hass, entry, f"Could not check background task {task_id}: {err}", logbook=False)
                continue
            if status is None:
                event = {**meta, "t": "task_failed", "error": "I lost track of it. The pi bridge may have restarted"}
            elif status.get("state") == "running":
                debug.log(
                    hass,
                    entry,
                    f"Background task still running after {status.get('seconds', 0):.0f} s"
                    + (f", now: {status['tool']}" if status.get("tool") else ""),
                    logbook=False,
                )
                continue
            else:
                event = {
                    **meta,
                    "t": f"task_{status.get('state')}",
                    "text": status.get("text"),
                    "error": status.get("error"),
                    "seconds": status.get("seconds"),
                }
            await _async_deliver(hass, entry, {**event, "task_id": task_id})


async def _async_deliver(
    hass: HomeAssistant, entry: PiAgentConfigEntry, event: dict[str, Any]
) -> None:
    """Announce a finished background task on the satellite that asked for it."""
    data = entry.runtime_data
    if (task_id := event.get("task_id")) is not None:
        if task_id in data.delivered:
            return
        data.delivered = [*data.delivered[-49:], task_id]
        data.tasks.pop(task_id, None)
    failed = event.get("t") == "task_failed"
    if failed:
        template = {**DEFAULT_OPTIONS, **entry.options}[CONF_FAILED_MESSAGE]
        text = template.replace("{error}", str(event.get("error") or "unknown error"))
    else:
        text = event.get("text") or "I'm done."
    satellite = event.get("satellite_id")
    hass.bus.async_fire(
        EVENT_TASK_FINISHED,
        {
            "text": text,
            "success": not failed,
            "error": event.get("error"),
            "satellite_id": satellite,
            "device_id": event.get("device_id"),
            "conversation_id": event.get("conversation_id"),
            "session_id": event.get("session_id"),
            "seconds": event.get("seconds"),
        },
    )
    seconds = event.get("seconds")
    debug.log(
        hass,
        entry,
        f"Background task {'failed' if failed else 'done'}"
        + (f" after {seconds:.0f} s" if isinstance(seconds, (int, float)) else "")
        + f" ({satellite or event.get('device_id') or 'no device'}): {text}"
        + (f" (reason: {event.get('error')})" if failed else ""),
    )
    # The face stops showing "working" (ESPHome devices with a pi_agent_working action)
    if used := await async_set_working(hass, satellite, event.get("device_id"), False):
        debug.log(hass, entry, f"esphome.{used}: working = false", logbook=False)
    options = {**DEFAULT_OPTIONS, **entry.options}
    if not options[CONF_ANNOUNCE]:
        return
    if satellite and hass.states.get(satellite) is not None:
        data: dict[str, Any] = {"message": text, "preannounce": False}
        # Speak with the voice of the assistant that uses pi; otherwise the satellite would use the voice of
        # whichever assistant it has selected
        agent_ids = {entry.entry_id} | ({entry.runtime_data.agent_entity_id} - {None})
        pipeline = None
        try:
            if (pipeline := pi_pipeline(hass, agent_ids)) is not None:
                if media_id := tts_media_id(hass, pipeline, text):
                    data["media_id"] = media_id
        except Exception:  # noqa: BLE001 - fall back to the satellite's own voice
            _LOGGER.warning("Could not prepare the announcement in pi's voice", exc_info=True)
        debug.log(
            hass,
            entry,
            f"Announcing on {satellite}"
            + (f" with the voice of assistant '{pipeline.name}'" if "media_id" in data and pipeline else "")
            + f": {text}",
            logbook=False,
        )
        try:
            await hass.services.async_call(
                "assist_satellite",
                "announce",
                data,
                target={"entity_id": satellite},
                blocking=True,
            )
        except Exception:  # noqa: BLE001 - fall back to a notification whatever went wrong
            _LOGGER.warning("Could not announce on %s", satellite, exc_info=True)
        else:
            return
    persistent_notification.async_create(hass, text, title=entry.title)
