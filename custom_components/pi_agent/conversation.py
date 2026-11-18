"""Conversation agent backed by pi."""

from __future__ import annotations

from collections.abc import AsyncGenerator
import logging
from typing import Any, Literal

from homeassistant.components import conversation
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import TemplateError
from homeassistant.helpers import intent, template
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import PiAgentConfigEntry
from .client import BridgeError, PiBridgeClient
from .const import (
    CONF_BUDGET,
    CONF_BUSY_MESSAGE,
    CONF_DETACH_MESSAGE,
    CONF_PROMPT,
    CONF_RESET_HOURS,
    CONF_SESSION_MODE,
    CONF_WORKSPACE,
    DEFAULT_OPTIONS,
    DOMAIN,
    SESSION_PER_DEVICE,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: PiAgentConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Set up the conversation entity."""
    async_add_entities([PiAgentConversationEntity(entry)])


class PiAgentConversationEntity(
    conversation.ConversationEntity, conversation.AbstractConversationAgent
):
    """A conversation agent that hands the conversation to pi."""

    _attr_has_entity_name = True
    _attr_name = None
    _attr_supports_streaming = True

    def __init__(self, entry: PiAgentConfigEntry) -> None:
        """Initialize."""
        self.entry = entry
        self._attr_unique_id = entry.entry_id
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name=entry.title,
            manufacturer="pi",
            model="pi va-bridge",
            entry_type=DeviceEntryType.SERVICE,
        )

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Return a list of supported languages."""
        return MATCH_ALL

    async def async_added_to_hass(self) -> None:
        """When entity is added to Home Assistant."""
        await super().async_added_to_hass()
        conversation.async_set_agent(self.hass, self.entry, self)

    async def async_will_remove_from_hass(self) -> None:
        """When entity will be removed from Home Assistant."""
        conversation.async_unset_agent(self.hass, self.entry)
        await super().async_will_remove_from_hass()

    def _build_request(
        self, user_input: conversation.ConversationInput, chat_log: conversation.ChatLog
    ) -> dict[str, Any]:
        options = {**DEFAULT_OPTIONS, **self.entry.options}
        instructions: list[str] = []
        if prompt := options[CONF_PROMPT]:
            instructions.append(
                template.Template(prompt, self.hass).async_render(
                    {"ha_name": self.hass.config.location_name}, parse_result=False
                )
            )
        if user_input.extra_system_prompt:
            instructions.append(user_input.extra_system_prompt)

        request: dict[str, Any] = {
            "text": user_input.text,
            "language": user_input.language,
            "conversation_id": chat_log.conversation_id,
            "device_id": user_input.device_id,
            "satellite_id": user_input.satellite_id,
            "instructions": "\n\n".join(instructions),
            "budget_s": options[CONF_BUDGET],
            "detach_message": options[CONF_DETACH_MESSAGE],
            "busy_message": options[CONF_BUSY_MESSAGE],
        }
        if options[CONF_SESSION_MODE] == SESSION_PER_DEVICE:
            # One long-running pi session per device, started fresh after a quiet period
            source = user_input.device_id or user_input.satellite_id or "default"
            request["session_key"] = f"device:{source}"
            request["reset_after_s"] = int(float(options[CONF_RESET_HOURS]) * 3600)
        else:
            request["session_key"] = f"conversation:{chat_log.conversation_id}"
        if workspace := options[CONF_WORKSPACE]:
            request["cwd"] = workspace
        return request

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Send the message to pi and stream the spoken reply into the chat log."""
        client = self.entry.runtime_data.client
        try:
            request = self._build_request(user_input, chat_log)
        except TemplateError as err:
            return _error_result(user_input, chat_log, f"Sorry, I had a problem with my template: {err}")

        try:
            async for _content in chat_log.async_add_delta_content_stream(
                self.entity_id, _transform_stream(client, request)
            ):
                pass
        except BridgeError as err:
            _LOGGER.error("pi bridge error: %s", err)
            return _error_result(user_input, chat_log, f"Sorry, there was a problem with pi: {err}")

        if not isinstance(chat_log.content[-1], conversation.AssistantContent):
            return _error_result(user_input, chat_log, "Sorry, pi did not answer.")
        return conversation.async_get_result_from_chat_log(user_input, chat_log)


async def _transform_stream(
    client: PiBridgeClient, request: dict[str, Any]
) -> AsyncGenerator[conversation.AssistantContentDeltaDict]:
    """Turn bridge events into chat log deltas: spoken text as content, tool use as thinking."""
    yield {"role": "assistant"}
    spoke = False
    async for event in client.turn(request):
        kind = event.get("t")
        if kind == "text":
            if text := event.get("d"):
                spoke = spoke or bool(text.strip())
                yield {"content": text}
        elif kind == "activity":
            yield {"thinking_content": f"{event.get('d')}\n"}
        elif kind == "detached":
            text = event.get("d") or ""
            yield {"content": f" {text}" if spoke else text}
        elif kind == "error":
            raise BridgeError(event.get("message") or "unknown error")


def _error_result(
    user_input: conversation.ConversationInput,
    chat_log: conversation.ChatLog,
    message: str,
) -> conversation.ConversationResult:
    response = intent.IntentResponse(language=user_input.language)
    response.async_set_error(intent.IntentResponseErrorCode.UNKNOWN, message)
    return conversation.ConversationResult(
        response=response, conversation_id=chat_log.conversation_id
    )
