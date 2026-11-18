"""Opt-in end-to-end test against a running bridge + pi.

PI_BRIDGE_URL=http://127.0.0.1:8787 PI_BRIDGE_TOKEN=... pytest tests/test_live_bridge.py
"""

import os

import pytest

from homeassistant.components import conversation
from homeassistant.const import CONF_API_TOKEN, CONF_URL
from homeassistant.core import Context, HomeAssistant

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.pi_agent.const import DEFAULT_OPTIONS, DOMAIN

URL = os.environ.get("PI_BRIDGE_URL")
pytestmark = pytest.mark.skipif(not URL, reason="PI_BRIDGE_URL not set")


@pytest.mark.timeout(180)
async def test_live_conversation(hass: HomeAssistant, socket_enabled) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        data={CONF_URL: URL, CONF_API_TOKEN: os.environ["PI_BRIDGE_TOKEN"]},
        options=dict(DEFAULT_OPTIONS),
        title="Pi Agent",
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()

    first = await conversation.async_converse(
        hass, "My cat is called Kattio. Reply with just OK.", None, Context(), agent_id="conversation.pi_agent"
    )
    assert first.response.speech["plain"]["speech"]
    second = await conversation.async_converse(
        hass, "What is my cat called?", first.conversation_id, Context(), agent_id="conversation.pi_agent"
    )
    assert "kattio" in second.response.speech["plain"]["speech"].lower()
    await hass.config_entries.async_unload(entry.entry_id)
