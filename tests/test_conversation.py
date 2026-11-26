"""Conversation agent tests."""

import asyncio

from homeassistant.components import conversation
from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers import chat_session

from pytest_homeassistant_custom_component.common import async_capture_events, async_mock_service

from custom_components.pi_agent.const import CONF_SESSION_MODE, EVENT_TASK_FINISHED

AGENT = "conversation.pi_agent"


async def _say(hass, text, conversation_id=None, **kwargs):
    return await conversation.async_converse(hass, text, conversation_id, Context(), agent_id=AGENT, **kwargs)


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
    assert sent["time_zone"] == hass.config.time_zone


async def test_tool_use_after_words_starts_the_speech(hass: HomeAssistant, bridge, setup_entry) -> None:
    """A short "Let me check." before the work goes to the chat log with a tool call (run by pi): that is what
    lets the voice pipeline speak it at once instead of after the work."""
    bridge.script = [
        {"t": "activity", "d": "memory: search"},
        {"t": "text", "d": "Let me check. "},
        {"t": "activity", "d": "bash: ls"},
        {"t": "text", "d": "Done."},
        {"t": "done"},
    ]
    result = await _say(hass, "check it", device_id="dev1")
    assert result.response.speech["plain"]["speech"] == "Let me check. Done."
    with (
        chat_session.async_get_chat_session(hass, result.conversation_id) as session,
        conversation.async_get_chat_log(hass, session) as chat_log,
    ):
        answer = chat_log.content[-1]
    calls = answer.tool_calls or []
    # only the tool used after something was said
    assert [(c.tool_name, c.tool_args, c.external) for c in calls] == [("pi", {"activity": "bash: ls"}, True)]


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
    # the failure message is configurable; {error} is the reason
    hass.config_entries.async_update_entry(
        setup_entry, options={**setup_entry.options, "failed_message": "That went wrong: {error}"}
    )
    await bridge.events.put({"t": "task_failed", "id": 1, "error": "boom"})
    for _ in range(50):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
        if hass.states.async_all("persistent_notification") or hass.data.get("persistent_notification"):
            break
    from homeassistant.components.persistent_notification import _async_get_or_create_notifications

    notifications = _async_get_or_create_notifications(hass)
    assert any(n["message"] == "That went wrong: boom" for n in notifications.values())


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
    timing = {
        "session_ready": 3,
        "llm": [{"start": 5, "first_token": 800, "first_text": 1200, "end": 1500, "chars": 6}],
        "tools": [{"name": "bash", "start": 1500, "ms": 1900}],
    }
    bridge.script = [
        {"t": "text", "d": "Hello."},
        {"t": "activity", "d": "bash: ls"},
        {"t": "done", "timing": timing},
    ]
    await _say(hass, "hi there", device_id="dev1")
    log = caplog.text
    assert "Timing (dev1): total " in log
    assert "model call 1: start 0.01s, first token 0.80s, first text 1.20s, done 1.50s, 6 chars" in log
    assert "tool bash: 1.90s (at 1.50s)" in log
    assert "Text stream (dev1): +0." in log and "'Hello.'" in log
    assert "Heard (dev1): hi there" in log
    assert "pi used (dev1): bash: ls" in log
    assert "pi answered (dev1): Hello." in log


async def test_status_check_delivers_a_task_whose_result_never_arrived(
    hass: HomeAssistant, bridge, monkeypatch, socket_enabled
) -> None:
    """The event stream missed the result: the periodic status check announces it, once; a task the bridge
    no longer knows is reported as lost."""
    monkeypatch.setattr("custom_components.pi_agent.TASK_CHECK_SECONDS", 0.05)
    from homeassistant.const import CONF_API_TOKEN, CONF_URL
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    from custom_components.pi_agent.const import DEFAULT_OPTIONS, DOMAIN

    from .conftest import TOKEN

    entry = MockConfigEntry(
        domain=DOMAIN, title="Pi Agent", data={CONF_URL: bridge.url, CONF_API_TOKEN: TOKEN},
        options=dict(DEFAULT_OPTIONS),
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    announce = async_mock_service(hass, "assist_satellite", "announce")
    hass.states.async_set("assist_satellite.kattio_box_1", "idle")

    bridge.script = [{"t": "detached", "d": "I'm on it.", "task_id": "t1"}]
    await _say(hass, "list the lights", satellite_id="assist_satellite.kattio_box_1")
    bridge.script = [{"t": "detached", "d": "I'm on it.", "task_id": "t2"}]
    await _say(hass, "and the switches", satellite_id="assist_satellite.kattio_box_1")
    assert set(entry.runtime_data.tasks) == {"t1", "t2"}

    bridge.tasks["t1"] = {"task_id": "t1", "state": "running", "seconds": 30}
    await asyncio.sleep(0.2)
    await hass.async_block_till_done()
    # t1 still running; t2 unknown to the bridge: reported as lost
    assert [c.data["message"] for c in announce] == ["Sorry, I couldn't finish that task."]
    bridge.tasks["t1"] = {"task_id": "t1", "state": "done", "seconds": 90, "text": "There are 12 lights."}
    for _ in range(20):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
    # the late event from the stream must not announce it a second time
    await bridge.events.put({"t": "task_done", "id": 1, "task_id": "t1", "text": "There are 12 lights."})
    for _ in range(10):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
    assert [c.data["message"] for c in announce][1:] == ["There are 12 lights."]
    assert entry.runtime_data.tasks == {}
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def test_loading_face_while_the_assistant_starts_up(
    hass: HomeAssistant, bridge, monkeypatch, socket_enabled
) -> None:
    """While the bridge reports ready: false, ESPHome devices with a pi_agent_loading action are told so
    (repeatedly); once ready, they are told once."""
    monkeypatch.setattr("custom_components.pi_agent.READY_CHECK_SECONDS", 0.05)
    from homeassistant.const import CONF_API_TOKEN, CONF_URL
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    from custom_components.pi_agent.const import DEFAULT_OPTIONS, DOMAIN

    from .conftest import TOKEN

    calls = async_mock_service(hass, "esphome", "kattio_box_1_pi_agent_loading")
    bridge.ready = False
    entry = MockConfigEntry(
        domain=DOMAIN, title="Pi Agent", data={CONF_URL: bridge.url, CONF_API_TOKEN: TOKEN},
        options=dict(DEFAULT_OPTIONS),
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    for _ in range(6):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
    assert len(calls) >= 2 and all(c.data == {"loading": True} for c in calls)
    bridge.ready = True
    for _ in range(10):
        await asyncio.sleep(0.05)
        await hass.async_block_till_done()
    assert calls[-1].data == {"loading": False}
    assert sum(1 for c in calls if c.data == {"loading": False}) == 1
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()


async def test_noise_filter_remark_then_quiet_end(hass: HomeAssistant, bridge, setup_entry) -> None:
    """TV after a false wake-up: a remark that keeps listening, then noise again ends quietly on the device."""
    from homeassistant.helpers import device_registry as dr
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    esphome_entry = MockConfigEntry(domain="esphome", data={"device_name": "kattio-box-1"})
    esphome_entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=esphome_entry.entry_id, identifiers={("esphome", "kattio")}
    )
    dismiss = async_mock_service(hass, "esphome", "kattio_box_1_pi_agent_dismiss")

    # the first text of a conversation from a voice device is screened
    bridge.script = [{"t": "text", "d": "Riveting news. Was that for me?"}, {"t": "done", "screened": "noise"}]
    first = await _say(hass, "and the weather in Oslo", device_id=device.id)
    assert bridge.turns[-1]["screen"] == "first"
    assert first.response.speech["plain"]["speech"] == "Riveting news. Was that for me?"
    assert first.continue_conversation is True

    # the answer to the remark is screened as a retry, with what came before
    bridge.script = [{"t": "done", "screened": "dismiss"}]
    second = await _say(hass, "buy now for only", device_id=device.id, conversation_id=first.conversation_id)
    sent = bridge.turns[-1]
    assert sent["screen"] == "retry"
    assert sent["screen_previous"] == {"heard": "and the weather in Oslo", "said": "Riveting news. Was that for me?"}
    assert second.response.speech["plain"]["speech"] == ""
    assert second.continue_conversation is False
    assert len(dismiss) == 1


async def test_noise_filter_quiet_listen(hass: HomeAssistant, bridge, setup_entry) -> None:
    """The assistant stays quiet about the TV: the device listens again, and what it hears next is screened."""
    from homeassistant.helpers import device_registry as dr
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    esphome_entry = MockConfigEntry(domain="esphome", data={"device_name": "kattio-box-2"})
    esphome_entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=esphome_entry.entry_id, identifiers={("esphome", "kattio2")}
    )
    listen = async_mock_service(hass, "esphome", "kattio_box_2_pi_agent_listen")

    bridge.script = [{"t": "done", "screened": "listen"}]
    first = await _say(hass, "and the financials", device_id=device.id)
    assert first.response.speech["plain"]["speech"] == ""
    assert len(listen) == 1

    # someone it knows speaks: a retry with what came before (nothing was said)
    bridge.script = [{"t": "text", "d": "What's up?"}, {"t": "done"}]
    await _say(hass, "[Anders] hey", device_id=device.id, conversation_id=first.conversation_id)
    assert bridge.turns[-1]["screen"] == "retry"
    assert bridge.turns[-1]["screen_previous"] == {"heard": "and the financials", "said": ""}


async def test_media_players_go_along(hass: HomeAssistant, bridge, setup_entry) -> None:
    """Voice requests say what the media players play (not the voice device's own), so the TV can be told apart."""
    from homeassistant.helpers import device_registry as dr, entity_registry as er
    from pytest_homeassistant_custom_component.common import MockConfigEntry

    esphome_entry = MockConfigEntry(domain="esphome", data={"device_name": "kattio-box-2"})
    esphome_entry.add_to_hass(hass)
    device = dr.async_get(hass).async_get_or_create(
        config_entry_id=esphome_entry.entry_id, identifiers={("esphome", "kattio3")}
    )
    er.async_get(hass).async_get_or_create(
        "media_player", "esphome", "box-speaker", device_id=device.id, suggested_object_id="box_speaker"
    )
    hass.states.async_set("media_player.box_speaker", "playing", {"friendly_name": "Box speaker"})
    hass.states.async_set(
        "media_player.tv", "playing", {"friendly_name": "Living room TV", "media_title": "Markets", "app_name": "YouTube"}
    )
    hass.states.async_set("media_player.kitchen", "off", {"friendly_name": "Kitchen"})

    bridge.script = [{"t": "text", "d": "Hi"}, {"t": "done"}]
    await _say(hass, "hello", device_id=device.id)
    assert bridge.turns[-1]["media"] == [
        {"name": "Living room TV", "state": "playing", "title": "Markets", "app": "YouTube"}
    ]
    # typed chat: nothing about media
    await _say(hass, "hello")
    assert "media" not in bridge.turns[-1]
    # nothing playing among all media players proves nothing: not sent
    hass.states.async_set("media_player.tv", "idle", {"friendly_name": "Living room TV"})
    await _say(hass, "hello", device_id=device.id)
    assert "media" not in bridge.turns[-1]
    # chosen entities (a TV's remote too): nothing on is worth saying
    hass.config_entries.async_update_entry(
        setup_entry, options={**setup_entry.options, "media_players": ["media_player.tv", "remote.tv"]}
    )
    hass.states.async_set("remote.tv", "off", {"friendly_name": "TV remote"})
    await _say(hass, "hello", device_id=device.id)
    assert bridge.turns[-1]["media"] == []
    hass.states.async_set("remote.tv", "on", {"friendly_name": "TV remote"})
    await _say(hass, "hello", device_id=device.id)
    assert bridge.turns[-1]["media"] == [{"name": "TV remote", "state": "on"}]


async def test_noise_filter_skips_follow_ups_and_text_chat(hass: HomeAssistant, bridge, setup_entry) -> None:
    bridge.script = [{"t": "text", "d": "Sure. Anything else?"}, {"t": "done"}]
    first = await _say(hass, "turn on the light", device_id="dev1")
    assert bridge.turns[-1]["screen"] == "first"
    # a follow-up in the same conversation is a real conversation: not screened
    await _say(hass, "and the kitchen", device_id="dev1", conversation_id=first.conversation_id)
    assert "screen" not in bridge.turns[-1]
    # typed text (no voice device) is never screened
    await _say(hass, "hello")
    assert "screen" not in bridge.turns[-1]
    # and the option switches it off
    hass.config_entries.async_update_entry(setup_entry, options={**setup_entry.options, "noise_filter": False})
    await _say(hass, "hi", device_id="dev2")
    assert "screen" not in bridge.turns[-1]


async def test_wakeup_asks_and_listens_or_announces(hass: HomeAssistant, bridge, setup_entry) -> None:
    """A wake-up pi set is spoken on its satellite; a question starts a conversation that listens for the answer."""
    from custom_components.pi_agent.const import EVENT_WAKEUP, SATELLITE_START_CONVERSATION

    start = async_mock_service(hass, "assist_satellite", "start_conversation")
    announce = async_mock_service(hass, "assist_satellite", "announce")
    fired = async_capture_events(hass, EVENT_WAKEUP)
    satellite = "assist_satellite.kattio_box_1"
    hass.states.async_set(
        satellite, "idle", {"supported_features": SATELLITE_START_CONVERSATION}
    )

    async def wait_for(calls):
        for _ in range(50):
            await asyncio.sleep(0.05)
            await hass.async_block_till_done()
            if calls:
                return

    await bridge.events.put(
        {"t": "wakeup", "id": 1, "satellite_id": satellite, "note": "ask about the concert", "text": "How was the concert?"}
    )
    await wait_for(start)
    assert start[0].data["start_message"] == "How was the concert?"
    assert "ask about the concert" in start[0].data["extra_system_prompt"]
    assert fired[0].data["text"] == "How was the concert?"

    await bridge.events.put({"t": "wakeup", "id": 2, "satellite_id": satellite, "text": "Time for the dentist."})
    await wait_for(announce)
    assert announce[0].data["message"] == "Time for the dentist."
    assert len(start) == 1
