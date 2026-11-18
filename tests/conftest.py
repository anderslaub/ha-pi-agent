"""Fixtures: a fake pi bridge served over real HTTP."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from aiohttp import web
from aiohttp.test_utils import TestServer
import pytest

from homeassistant.const import CONF_API_TOKEN, CONF_URL
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.pi_agent.const import DEFAULT_OPTIONS, DOMAIN

pytest_plugins = "pytest_homeassistant_custom_component"

TOKEN = "test-token-1234567890"


@pytest.fixture(autouse=True)
async def auto_enable_custom_integrations(hass: HomeAssistant, enable_custom_integrations):
    """Enable custom integrations and the core component conversation depends on."""
    assert await async_setup_component(hass, "homeassistant", {})


class FakeBridge:
    """Minimal stand-in for bridge/src/server.ts."""

    def __init__(self) -> None:
        self.turns: list[dict[str, Any]] = []
        self.script: list[dict[str, Any]] = [{"t": "text", "d": "Hi."}, {"t": "done"}]
        self.closed = False
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self.app = web.Application()
        self.app.router.add_get("/v1/health", self.health)
        self.app.router.add_post("/v1/turn", self.turn)
        self.app.router.add_get("/v1/events", self.stream_events)
        self.server = TestServer(self.app)

    def _authorized(self, request: web.Request) -> bool:
        return request.headers.get("Authorization") == f"Bearer {TOKEN}"

    async def health(self, request: web.Request) -> web.Response:
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        return web.json_response({"ok": True, "last_event_id": 0})

    async def turn(self, request: web.Request) -> web.StreamResponse:
        if not self._authorized(request):
            return web.json_response({"error": "unauthorized"}, status=401)
        self.turns.append(await request.json())
        resp = web.StreamResponse()
        await resp.prepare(request)
        for event in self.script:
            await resp.write((json.dumps(event) + "\n").encode())
        await resp.write_eof()
        return resp

    async def stream_events(self, request: web.Request) -> web.StreamResponse:
        resp = web.StreamResponse()
        await resp.prepare(request)
        await resp.write(b'{"t": "hello", "last_id": 0}\n')
        while not self.closed:
            try:
                event = await asyncio.wait_for(self.events.get(), 0.1)
            except TimeoutError:
                continue
            await resp.write((json.dumps(event) + "\n").encode())
        return resp

    @property
    def url(self) -> str:
        return str(self.server.make_url("")).rstrip("/")


@pytest.fixture
async def bridge(socket_enabled):
    """Run the fake bridge."""
    fake = FakeBridge()
    await fake.server.start_server()
    yield fake
    fake.closed = True
    await fake.server.close()


@pytest.fixture
async def setup_entry(hass: HomeAssistant, bridge: FakeBridge):
    """Set up the integration against the fake bridge."""
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Pi Agent",
        data={CONF_URL: bridge.url, CONF_API_TOKEN: TOKEN},
        options=dict(DEFAULT_OPTIONS),
    )
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    yield entry
    await hass.config_entries.async_unload(entry.entry_id)
    await hass.async_block_till_done()
