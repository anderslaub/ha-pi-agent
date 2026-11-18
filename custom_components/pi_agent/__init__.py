"""Pi Agent: use the pi coding agent harness as a Home Assistant conversation agent."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import logging
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import CONF_API_TOKEN, CONF_URL, Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import BridgeAuthError, BridgeError, PiBridgeClient
from .const import CONF_ANNOUNCE, DEFAULT_OPTIONS, DOMAIN, EVENT_TASK_FINISHED

_LOGGER = logging.getLogger(__name__)

PLATFORMS = [Platform.CONVERSATION]


@dataclass
class PiAgentData:
    """Runtime data."""

    client: PiBridgeClient


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


async def _async_deliver(
    hass: HomeAssistant, entry: PiAgentConfigEntry, event: dict[str, Any]
) -> None:
    """Announce a finished background task on the satellite that asked for it."""
    failed = event.get("t") == "task_failed"
    text = (
        f"Sorry, that task failed: {event.get('error')}"
        if failed
        else (event.get("text") or "I'm done.")
    )
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
    options = {**DEFAULT_OPTIONS, **entry.options}
    if not options[CONF_ANNOUNCE]:
        return
    if satellite and hass.states.get(satellite) is not None:
        try:
            await hass.services.async_call(
                "assist_satellite",
                "announce",
                {"message": text, "preannounce": False},
                target={"entity_id": satellite},
                blocking=True,
            )
        except Exception:  # noqa: BLE001 - fall back to a notification whatever went wrong
            _LOGGER.warning("Could not announce on %s", satellite, exc_info=True)
        else:
            return
    persistent_notification.async_create(hass, text, title=entry.title)
