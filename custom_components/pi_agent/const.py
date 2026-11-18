"""Constants for the Pi Agent integration."""

from typing import Final

DOMAIN: Final = "pi_agent"

CONF_PROMPT: Final = "prompt"
CONF_BUDGET: Final = "reply_budget"
CONF_SESSION_MODE: Final = "session_mode"
CONF_RESET_HOURS: Final = "reset_hours"
CONF_ANNOUNCE: Final = "announce"
CONF_DETACH_MESSAGE: Final = "detach_message"
CONF_BUSY_MESSAGE: Final = "busy_message"
CONF_WORKSPACE: Final = "workspace"
CONF_DEBUG: Final = "debug"

SESSION_PER_CONVERSATION: Final = "per_conversation"
SESSION_PER_DEVICE: Final = "per_device"

DEFAULT_OPTIONS: Final = {
    CONF_PROMPT: "",
    CONF_BUDGET: 15,
    CONF_SESSION_MODE: SESSION_PER_CONVERSATION,
    CONF_RESET_HOURS: 4,
    CONF_ANNOUNCE: True,
    CONF_DETACH_MESSAGE: "I'm on it. I'll let you know when it's done.",
    CONF_BUSY_MESSAGE: "I'm still working on the last thing. I'll get to that right after.",
    CONF_WORKSPACE: "",
    CONF_DEBUG: False,
}

EVENT_TASK_STARTED: Final = "pi_agent_task_started"
EVENT_TASK_FINISHED: Final = "pi_agent_task_finished"
