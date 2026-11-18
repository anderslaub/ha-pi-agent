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


async def test_working_face_and_announcement_in_pis_voice(
    hass: HomeAssistant, bridge, setup_entry, monkeypatch
) -> None:
    """A detached task tells the ESPHome satellite it is working; the result is spoken in pi's voice."""
    from homeassistant.helpers import device_registry as dr, entity_registry as er
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    import custom_components.pi_agent as pi_agent
    from custom_components.pi_agent.const import EVENT_TASK_STARTED

    esphome_entry = MockConfigEntry(domain="esphome", data={"device_name": "kattio-box-1"})
    esphome_entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=esphome_entry.entry_id, identifiers={("esphome", "kattio")}
    )
    er.async_get(hass).async_get_or_create(
        "assist_satellite", "esphome", "kattio-sat", device_id=device.id, suggested_object_id="kattio_box_1"
    )
    satellite = "assist_satellite.kattio_box_1"
    hass.states.async_set(satellite, "idle")
    working = async_mock_service(hass, "esphome", "kattio_box_1_pi_agent_working")
    announce = async_mock_service(hass, "assist_satellite", "announce")
    started = async_capture_events(hass, EVENT_TASK_STARTED)

    class FakePipeline:
        name = "Kattio pi"
        tts_engine = "tts.jetson"

    monkeypatch.setattr(pi_agent, "pi_pipeline", lambda hass, ids: FakePipeline())
    monkeypatch.setattr(pi_agent, "tts_media_id", lambda hass, p, text: f"media-source://tts/{p.tts_engine}?{text}")

    bridge.script = [{"t": "detached", "d": "I'm on it."}]
    await _say(hass, "research cats", satellite_id=satellite)
    assert [c.data["working"] for c in working] == [True]
    assert started[0].data["satellite_id"] == satellite

    await bridge.events.put({"t": "task_done", "id": 1, "satellite_id": satellite, "text": "Done."})
    for _ in range(50):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
        if announce:
            break
    assert [c.data["working"] for c in working] == [True, False]
    assert announce[0].data["media_id"] == "media-source://tts/tts.jetson?Done."
    assert announce[0].data["message"] == "Done."


async def test_debug_mode_logs_texts(hass: HomeAssistant, bridge, setup_entry, caplog) -> None:
    hass.config_entries.async_update_entry(setup_entry, options={**setup_entry.options, "debug": True})
    bridge.script = [{"t": "text", "d": "Hello."}, {"t": "activity", "d": "bash: ls"}, {"t": "done"}]
    await _say(hass, "hi there", device_id="dev1")
    log = caplog.text
    assert "Heard (dev1): hi there" in log
    assert "pi used (dev1): bash: ls" in log
    assert "pi answered (dev1): Hello." in log
