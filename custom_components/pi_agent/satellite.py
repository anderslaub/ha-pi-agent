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


def _device_id(hass: HomeAssistant, satellite_id: str | None, device_id: str | None) -> str | None:
    if satellite_id and (entry := er.async_get(hass).async_get(satellite_id)) and entry.device_id:
        return entry.device_id
    return device_id


def esphome_working_service(
    hass: HomeAssistant, satellite_id: str | None, device_id: str | None
) -> str | None:
    """The satellite's esphome.<node>_pi_agent_working action, if its firmware has one."""
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
        service = f"{name.replace('-', '_')}_{WORKING_ACTION}"
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
