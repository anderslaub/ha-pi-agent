"""Conversation agent tests."""

import asyncio

from homeassistant.components import conversation
from homeassistant.core import Context, HomeAssistant

from pytest_homeassistant_custom_component.common import async_capture_events, async_mock_service

from custom_components.pi_agent.const import CONF_SESSION_MODE, EVENT_TASK_FINISHED

AGENT = "conversation.pi_agent"


async def _say(hass, text, **kwargs):
    return await conversation.async_converse(hass, text, None, Context(), agent_id=AGENT, **kwargs)


async def test_streamed_reply(hass: HomeAssistant, bridge, setup_entry) -> None:
    bridge.script = [
        {"t": "text", "d": "Hello there. "},
        {"t": "activity", "d": "bash: ls"},
        {"t": "text", "d": "How can I help?"},
        {"t": "done"},
    ]
    result = await _say(hass, "hi", language="en", device_id="dev1")
    assert result.response.speech["plain"]["speech"] == "Hello there. How can I help?"
    assert result.continue_conversation is True  # ends with a question: keep listening

    sent = bridge.turns[-1]
    assert sent["text"] == "hi"
    assert sent["language"] == "en"
    assert sent["device_id"] == "dev1"
    assert sent["session_key"] == f"conversation:{result.conversation_id}"
    assert sent["budget_s"] == 15


async def test_session_per_device(hass: HomeAssistant, bridge, setup_entry) -> None:
    hass.config_entries.async_update_entry(
        setup_entry, options={**setup_entry.options, CONF_SESSION_MODE: "per_device", "reset_hours": 1}
    )
    await _say(hass, "hi", device_id="dev9")
    assert bridge.turns[-1]["session_key"] == "device:dev9"
    assert bridge.turns[-1]["reset_after_s"] == 3600


async def test_error_is_spoken(hass: HomeAssistant, bridge, setup_entry) -> None:
    bridge.script = [{"t": "error", "message": "model overloaded"}]
    result = await _say(hass, "hi")
    assert "model overloaded" in result.response.speech["plain"]["speech"]


async def test_background_task_is_announced(hass: HomeAssistant, bridge, setup_entry) -> None:
    announce = async_mock_service(hass, "assist_satellite", "announce")
    finished = async_capture_events(hass, EVENT_TASK_FINISHED)
    hass.states.async_set("assist_satellite.kattio_box_1", "idle")

    bridge.script = [
        {"t": "text", "d": "Let me look into that."},
        {"t": "detached", "d": "I'm on it."},
    ]
    result = await _say(hass, "research cats", satellite_id="assist_satellite.kattio_box_1")
    assert result.response.speech["plain"]["speech"] == "Let me look into that. I'm on it."
    assert result.continue_conversation is False

    await bridge.events.put(
        {"t": "task_done", "id": 1, "satellite_id": "assist_satellite.kattio_box_1", "text": "Cats sleep a lot."}
    )
    for _ in range(50):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
        if announce:
            break
    assert len(announce) == 1
    assert announce[0].data["message"] == "Cats sleep a lot."
    assert announce[0].data["entity_id"] == "assist_satellite.kattio_box_1"
    assert finished[0].data["success"] is True


async def test_background_task_without_satellite_notifies(hass: HomeAssistant, bridge, setup_entry) -> None:
    await bridge.events.put({"t": "task_failed", "id": 1, "error": "boom"})
    for _ in range(50):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
        if hass.states.async_all("persistent_notification") or hass.data.get("persistent_notification"):
            break
    from homeassistant.components.persistent_notification import _async_get_or_create_notifications

    notifications = _async_get_or_create_notifications(hass)
    assert any("boom" in n["message"] for n in notifications.values())
