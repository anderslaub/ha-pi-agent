"""Config flow for Pi Agent."""

from __future__ import annotations

from collections.abc import Mapping
import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_API_TOKEN, CONF_NAME, CONF_URL
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TemplateSelector,
    TextSelector,
    TextSelectorConfig,
    TextSelectorType,
)

from .client import BridgeAuthError, BridgeError, PiBridgeClient
from .const import (
    CONF_ANNOUNCE,
    CONF_BUDGET,
    CONF_BUSY_MESSAGE,
    CONF_DEBUG,
    CONF_DETACH_MESSAGE,
    CONF_FAILED_MESSAGE,
    CONF_NOISE_FILTER,
    CONF_PROMPT,
    CONF_RESET_HOURS,
    CONF_SESSION_MODE,
    CONF_WORKSPACE,
    DEFAULT_OPTIONS,
    DOMAIN,
    SESSION_PER_CONVERSATION,
    SESSION_PER_DEVICE,
)

_LOGGER = logging.getLogger(__name__)

PASSWORD = TextSelector(TextSelectorConfig(type=TextSelectorType.PASSWORD))


async def _validate(hass, url: str, token: str) -> dict[str, str]:
    """Return errors (empty when the bridge answered)."""
    client = PiBridgeClient(async_get_clientsession(hass), url, token)
    try:
        await client.health()
    except BridgeAuthError:
        return {"base": "invalid_auth"}
    except BridgeError:
        return {"base": "cannot_connect"}
    except Exception:
        _LOGGER.exception("Unexpected error talking to the pi bridge")
        return {"base": "unknown"}
    return {}


class PiAgentConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Pi Agent."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for the bridge URL and token."""
        errors: dict[str, str] = {}
        if user_input is not None:
            url = user_input[CONF_URL].strip().rstrip("/")
            self._async_abort_entries_match({CONF_URL: url})
            errors = await _validate(self.hass, url, user_input[CONF_API_TOKEN])
            if not errors:
                return self.async_create_entry(
                    title=user_input.get(CONF_NAME) or "Pi Agent",
                    data={CONF_URL: url, CONF_API_TOKEN: user_input[CONF_API_TOKEN]},
                    options=dict(DEFAULT_OPTIONS),
                )
        schema = vol.Schema(
            {
                vol.Required(CONF_NAME, default="Pi Agent"): str,
                vol.Required(CONF_URL, default="http://"): str,
                vol.Required(CONF_API_TOKEN): PASSWORD,
            }
        )
        return self.async_show_form(
            step_id="user",
            data_schema=self.add_suggested_values_to_schema(schema, user_input),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """The bridge rejected the token."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for a new token."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}
        if user_input is not None:
            errors = await _validate(
                self.hass, entry.data[CONF_URL], user_input[CONF_API_TOKEN]
            )
            if not errors:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_API_TOKEN: user_input[CONF_API_TOKEN]}
                )
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema({vol.Required(CONF_API_TOKEN): PASSWORD}),
            description_placeholders={"url": entry.data[CONF_URL]},
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        """Create the options flow."""
        return PiAgentOptionsFlow()


class PiAgentOptionsFlow(OptionsFlow):
    """Assistant behaviour options."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Manage the options."""
        if user_input is not None:
            return self.async_create_entry(data={**DEFAULT_OPTIONS, **user_input})
        schema = vol.Schema(
            {
                vol.Optional(CONF_PROMPT): TemplateSelector(),
                vol.Required(CONF_BUDGET): NumberSelector(
                    NumberSelectorConfig(
                        min=3, max=120, step=1, unit_of_measurement="s", mode=NumberSelectorMode.BOX
                    )
                ),
                vol.Required(CONF_SESSION_MODE): SelectSelector(
                    SelectSelectorConfig(
                        options=[SESSION_PER_CONVERSATION, SESSION_PER_DEVICE],
                        translation_key=CONF_SESSION_MODE,
                        mode=SelectSelectorMode.LIST,
                    )
                ),
                vol.Required(CONF_RESET_HOURS): NumberSelector(
                    NumberSelectorConfig(
                        min=0.25, max=72, step=0.25, unit_of_measurement="h", mode=NumberSelectorMode.BOX
                    )
                ),
                vol.Required(CONF_ANNOUNCE): BooleanSelector(),
                vol.Required(CONF_DETACH_MESSAGE): TextSelector(),
                vol.Required(CONF_BUSY_MESSAGE): TextSelector(),
                vol.Optional(CONF_FAILED_MESSAGE): TextSelector(),
                vol.Optional(CONF_NOISE_FILTER, default=True): BooleanSelector(),
                vol.Optional(CONF_WORKSPACE): TextSelector(),
                vol.Optional(CONF_DEBUG, default=False): BooleanSelector(),
            }
        )
        return self.async_show_form(
            step_id="init",
            data_schema=self.add_suggested_values_to_schema(
                schema, {**DEFAULT_OPTIONS, **self.config_entry.options}
            ),
        )
