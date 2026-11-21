"""Conversation agent backed by pi."""

from __future__ import annotations

from collections.abc import AsyncGenerator
import logging
import time
from typing import Any, Literal

from homeassistant.components import conversation
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import TemplateError
from homeassistant.helpers import intent, template
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import PiAgentConfigEntry, debug
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
    EVENT_TASK_STARTED,
    SESSION_PER_DEVICE,
)
from .satellite import async_set_working

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
        self.entry.runtime_data.agent_entity_id = self.entity_id
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

        source = user_input.satellite_id or user_input.device_id or "text"
        debug.log(self.hass, self.entry, f"Heard ({source}): {user_input.text}")
        turn = _Turn()
        try:
            async for _content in chat_log.async_add_delta_content_stream(
                self.entity_id, self._transform_stream(client, request, user_input, turn)
            ):
                pass
        except BridgeError as err:
            _LOGGER.error("pi bridge error: %s", err)
            debug.log(self.hass, self.entry, f"Error ({source}): {err}")
            return _error_result(user_input, chat_log, f"Sorry, there was a problem with pi: {err}")
        finally:
            if turn.tools:
                debug.log(self.hass, self.entry, f"pi used ({source}): {'; '.join(turn.tools)}", logbook=False)

        if debug.enabled(self.entry):
            debug.log(self.hass, self.entry, f"Timing ({source}): {debug.timing_summary(turn.timeline())}")
            debug.log(
                self.hass,
                self.entry,
                f"Text stream ({source}): {debug.text_stream(turn.texts)}",
                logbook=False,
            )
        debug.log(
            self.hass,
            self.entry,
            f"pi answered ({source}){' and works on in the background' if turn.detached else ''}: "
            f"{''.join(turn.reply).strip()}",
        )
        if not isinstance(chat_log.content[-1], conversation.AssistantContent):
            return _error_result(user_input, chat_log, "Sorry, pi did not answer.")
        return conversation.async_get_result_from_chat_log(user_input, chat_log)

    async def _transform_stream(
        self,
        client: PiBridgeClient,
        request: dict[str, Any],
        user_input: conversation.ConversationInput,
        turn: _Turn,
    ) -> AsyncGenerator[conversation.AssistantContentDeltaDict]:
        """Turn bridge events into chat log deltas: spoken text as content, tool use as thinking."""
        yield {"role": "assistant"}
        spoke = False
        async for event in client.turn(request):
            kind = event.get("t")
            if kind in ("done", "detached"):
                turn.bridge = event.get("timing") or {}
            if kind == "text":
                if text := event.get("d"):
                    spoke = spoke or bool(text.strip())
                    turn.reply.append(text)
                    turn.texts.append((turn.elapsed(), text))
                    yield {"content": text}
            elif kind == "activity":
                turn.tools.append(str(event.get("d")))
                yield {"thinking_content": f"{event.get('d')}\n"}
            elif kind == "detached":
                text = event.get("d") or ""
                turn.detached = True
                turn.reply.append(f" {text}" if spoke else text)
                # pi carries on in the background: the voice device can show that (instead of waiting for
                # an answer), until the result is announced
                self.hass.bus.async_fire(
                    EVENT_TASK_STARTED,
                    {
                        "satellite_id": user_input.satellite_id,
                        "device_id": user_input.device_id,
                        "conversation_id": request.get("conversation_id"),
                    },
                )
                if used := await async_set_working(
                    self.hass, user_input.satellite_id, user_input.device_id, True
                ):
                    debug.log(self.hass, self.entry, f"esphome.{used}: working = true", logbook=False)
                yield {"content": f" {text}" if spoke else text}
            elif kind == "error":
                raise BridgeError(event.get("message") or "unknown error")


class _Turn:
    """What happened in one turn, for debug mode."""

    def __init__(self) -> None:
        self.started = time.monotonic()
        self.reply: list[str] = []
        self.tools: list[str] = []
        self.detached = False
        # (seconds since the request, text) as each piece arrived from the bridge
        self.texts: list[tuple[float, str]] = []
        # the bridge's own timing (ms since it got the request), from its done/detached event
        self.bridge: dict[str, Any] = {}

    def elapsed(self) -> float:
        return time.monotonic() - self.started

    def timeline(self) -> dict[str, Any]:
        return {"total": self.elapsed(), "texts": [t for t, _ in self.texts], "bridge": self.bridge}


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
