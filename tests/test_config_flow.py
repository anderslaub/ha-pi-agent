"""Config flow tests."""

from homeassistant import config_entries
from homeassistant.const import CONF_API_TOKEN, CONF_NAME, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from custom_components.pi_agent.const import CONF_BUDGET, CONF_SESSION_MODE, DOMAIN

from .conftest import TOKEN


async def test_user_flow(hass: HomeAssistant, bridge) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": config_entries.SOURCE_USER})
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_NAME: "Pi", CONF_URL: bridge.url + "/", CONF_API_TOKEN: "wrong"}
    )
    assert result["errors"] == {"base": "invalid_auth"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_NAME: "Pi", CONF_URL: "http://127.0.0.1:1", CONF_API_TOKEN: TOKEN}
    )
    assert result["errors"] == {"base": "cannot_connect"}

    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_NAME: "Pi", CONF_URL: bridge.url + "/", CONF_API_TOKEN: TOKEN}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Pi"
    assert result["data"] == {CONF_URL: bridge.url, CONF_API_TOKEN: TOKEN}
    assert result["options"][CONF_BUDGET] == 15


async def test_options_flow(hass: HomeAssistant, setup_entry) -> None:
    result = await hass.config_entries.options.async_init(setup_entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.options.async_configure(
        result["flow_id"],
        {
            CONF_BUDGET: 30,
            CONF_SESSION_MODE: "per_device",
            "reset_hours": 2,
            "announce": False,
            "detach_message": "Working on it.",
            "busy_message": "Busy.",
        },
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert setup_entry.options[CONF_BUDGET] == 30
    assert setup_entry.options["prompt"] == ""
