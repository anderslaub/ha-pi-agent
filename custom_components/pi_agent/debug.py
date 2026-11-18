"""Debug mode: every text that goes to and from pi, in the Home Assistant log and the logbook."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant

from .const import CONF_DEBUG, DEFAULT_OPTIONS

if TYPE_CHECKING:
    from . import PiAgentConfigEntry

LOGGER = logging.getLogger(f"{__package__}.debug")


def enabled(entry: PiAgentConfigEntry) -> bool:
    """Whether debug mode is on."""
    return bool({**DEFAULT_OPTIONS, **entry.options}[CONF_DEBUG])


def log(
    hass: HomeAssistant, entry: PiAgentConfigEntry, message: str, *, logbook: bool = True
) -> None:
    """Log one line when debug mode is on (logbook too, unless it is a detail)."""
    if not enabled(entry):
        return
    # Without this, INFO lines vanish under Home Assistant's default "warning" log level
    if LOGGER.getEffectiveLevel() > logging.INFO:
        LOGGER.setLevel(logging.INFO)
    LOGGER.info("%s", message)
    if logbook and hass.services.has_service("logbook", "log"):
        data = {"name": entry.title, "message": message[:2000], "domain": "pi_agent"}
        if (entity_id := entry.runtime_data.agent_entity_id) is not None:
            data["entity_id"] = entity_id
        hass.async_create_task(hass.services.async_call("logbook", "log", data))
