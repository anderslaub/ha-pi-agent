"""Debug mode: every text that goes to and from pi, in the Home Assistant log and the logbook."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

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


def _s(ms: float | None) -> str:
    return "?" if ms is None else f"{ms / 1000:.2f}s"


def timing_summary(timeline: dict[str, Any]) -> str:
    """One line: where the time of a turn went (model, tools, the text stream to the TTS)."""
    bridge = timeline.get("bridge") or {}
    texts: list[float] = timeline.get("texts") or []
    parts = [f"total {timeline['total']:.2f}s"]
    if texts:
        parts.append(f"first text {texts[0]:.2f}s, last text {texts[-1]:.2f}s ({len(texts)} pieces)")
        gaps = [(b - a, a) for a, b in zip(texts, texts[1:])]
        if gaps:
            gap, at = max(gaps)
            parts.append(f"longest pause in the text {gap:.2f}s (after {at:.2f}s)")
    else:
        parts.append("no text")
    if (ready := bridge.get("session_ready")) is not None and ready > 200:
        parts.append(f"session start {_s(ready)}")
    for i, call in enumerate(bridge.get("llm") or [], 1):
        parts.append(
            f"model call {i}: start {_s(call.get('start'))}, first token {_s(call.get('first_token'))}, "
            f"first text {_s(call.get('first_text'))}, done {_s(call.get('end'))}, {call.get('chars', 0)} chars"
        )
    for tool in bridge.get("tools") or []:
        parts.append(f"tool {tool.get('name')}: {_s(tool.get('ms'))} (at {_s(tool.get('start'))})")
    if bridge.get("detached") is not None:
        parts.append(f"went to the background at {_s(bridge['detached'])}")
    return "; ".join(parts)


def text_stream(texts: list[tuple[float, str]]) -> str:
    """Every piece of text as it arrived, with its time: shows whether the model or the TTS is slow."""
    return " | ".join(f"+{t:.2f}s {text.strip()[:60]!r}" for t, text in texts) or "(none)"
