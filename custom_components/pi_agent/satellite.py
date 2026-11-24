"""Voice satellite helpers: the working state on ESPHome devices, and announcements in pi's own voice."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

if TYPE_CHECKING:
    from homeassistant.components.assist_pipeline import Pipeline

_LOGGER = logging.getLogger(__name__)

# ESPHome devices can define this API action (variables: working: bool) to show that pi is busy.
WORKING_ACTION = "pi_agent_working"
# ... and this one (variables: loading: bool) to show that the assistant is still starting up.
LOADING_ACTION = "pi_agent_loading"
# ... and this one (no variables) to end the conversation quietly: the noise filter decided it was the TV talking.
DISMISS_ACTION = "pi_agent_dismiss"
# ... and this one (no variables) to listen a few seconds more without saying anything first: the assistant heard
# background noise and chose to stay quiet. Without it the conversation just ends.
LISTEN_ACTION = "pi_agent_listen"


def _device_id(hass: HomeAssistant, satellite_id: str | None, device_id: str | None) -> str | None:
    if satellite_id and (entry := er.async_get(hass).async_get(satellite_id)) and entry.device_id:
        return entry.device_id
    return device_id


def esphome_working_service(
    hass: HomeAssistant, satellite_id: str | None, device_id: str | None
) -> str | None:
    """The satellite's esphome.<node>_pi_agent_working action, if its firmware has one."""
    return esphome_service(hass, satellite_id, device_id, WORKING_ACTION)


def esphome_service(
    hass: HomeAssistant, satellite_id: str | None, device_id: str | None, action: str
) -> str | None:
    """The satellite's esphome.<node>_<action> action, if its firmware has one."""
    if not (dev_id := _device_id(hass, satellite_id, device_id)):
        return None
    if not (device := dr.async_get(hass).async_get(dev_id)):
        return None
    for entry_id in device.config_entries:
        entry = hass.config_entries.async_get_entry(entry_id)
        if entry is None or entry.domain != "esphome":
            continue
        info = getattr(getattr(entry, "runtime_data", None), "device_info", None)
        name = getattr(info, "name", None) or entry.data.get("device_name")
        if not name:
            continue
        service = f"{name.replace('-', '_')}_{action}"
        if hass.services.has_service("esphome", service):
            return service
    return None


async def async_set_working(
    hass: HomeAssistant, satellite_id: str | None, device_id: str | None, working: bool
) -> str | None:
    """Tell the satellite that pi works in the background (or is done). Returns the action used."""
    if not (service := esphome_working_service(hass, satellite_id, device_id)):
        return None
    try:
        await hass.services.async_call("esphome", service, {"working": working}, blocking=True)
    except Exception:  # noqa: BLE001 - a face that does not update must never break the conversation
        _LOGGER.warning("Could not call esphome.%s", service, exc_info=True)
        return None
    return service


async def async_dismiss(hass: HomeAssistant, satellite_id: str | None, device_id: str | None) -> str | None:
    """Tell the satellite to end the conversation quietly (no more listening). Returns the action used."""
    if not (service := esphome_service(hass, satellite_id, device_id, DISMISS_ACTION)):
        return None
    try:
        await hass.services.async_call("esphome", service, {}, blocking=True)
    except Exception:  # noqa: BLE001
        _LOGGER.warning("Could not call esphome.%s", service, exc_info=True)
        return None
    return service


async def async_listen(hass: HomeAssistant, satellite_id: str | None, device_id: str | None) -> str | None:
    """Tell the satellite to listen again without a reply first. Returns the action used."""
    if not (service := esphome_service(hass, satellite_id, device_id, LISTEN_ACTION)):
        return None
    try:
        await hass.services.async_call("esphome", service, {}, blocking=True)
    except Exception:  # noqa: BLE001
        _LOGGER.warning("Could not call esphome.%s", service, exc_info=True)
        return None
    return service


async def async_set_loading(hass: HomeAssistant, loading: bool) -> list[str]:
    """Tell every ESPHome device with a pi_agent_loading action whether the assistant is still starting up."""
    services = [
        name for name in hass.services.async_services_for_domain("esphome") if name.endswith(f"_{LOADING_ACTION}")
    ]
    for service in services:
        try:
            await hass.services.async_call("esphome", service, {"loading": loading}, blocking=True)
        except Exception:  # noqa: BLE001 - one unreachable device must not stop the others
            _LOGGER.debug("Could not call esphome.%s", service, exc_info=True)
    return services


def pi_pipeline(hass: HomeAssistant, agent_ids: set[str]) -> Pipeline | None:
    """The assist pipeline that uses this agent, so announcements get the same voice as its answers."""
    from homeassistant.components.assist_pipeline import async_get_pipelines  # noqa: PLC0415

    for pipeline in async_get_pipelines(hass):
        if pipeline.conversation_engine in agent_ids and pipeline.tts_engine:
            return pipeline
    return None


def tts_media_id(hass: HomeAssistant, pipeline: Pipeline, text: str) -> str | None:
    """A TTS media source id for the text, spoken with the pipeline's TTS engine and voice."""
    from homeassistant.components import tts  # noqa: PLC0415

    engine = tts.async_resolve_engine(hass, pipeline.tts_engine)
    if engine is None:
        return None
    options: dict[str, Any] = {}
    if pipeline.tts_voice is not None:
        options[tts.ATTR_VOICE] = pipeline.tts_voice
    return tts.generate_media_source_id(
        hass, text, engine=engine, language=pipeline.tts_language, options=options
    )


# What a media player reports while it may be making sound (a TV often says "on" without "playing"); other
# entities (a TV's remote, a smart plug, a switch) count when they are "on"
_SOUNDING = {"playing", "on", "buffering"}
_MEDIA_ATTRS = {
    "title": "media_title",
    "artist": "media_artist",
    "series": "media_series_title",
    "channel": "media_channel",
    "app": "app_name",
}


def media_now(
    hass: HomeAssistant, entity_ids: list[str], satellite_id: str | None, device_id: str | None
) -> list[dict[str, str]] | None:
    """What may be making sound now: the chosen entities that are playing or on, with their titles.

    With chosen entities, an empty list means nothing plays. Without (entity_ids empty) every media player is looked
    at, except the voice device's own; then not finding one playing proves nothing (a TV may not be a media player
    in Home Assistant), so it is None, the same as not knowing.
    """
    own = _device_id(hass, satellite_id, device_id)
    registry = er.async_get(hass)
    players = entity_ids or hass.states.async_entity_ids("media_player")
    out: list[dict[str, str]] = []
    for entity_id in players:
        entry = registry.async_get(entity_id)
        if not entity_ids and own and entry is not None and entry.device_id == own:
            continue  # the voice device's own speaker: that is the assistant talking
        state = hass.states.get(entity_id)
        if state is None or state.state not in _SOUNDING:
            continue
        item = {"name": str(state.attributes.get("friendly_name") or entity_id), "state": state.state}
        for key, attr in _MEDIA_ATTRS.items():
            if value := state.attributes.get(attr):
                item[key] = str(value)
        out.append(item)
    if not out and not entity_ids:
        return None
    return out
