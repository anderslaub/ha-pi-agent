"""Client for va-bridge, the pi side of this integration."""

from __future__ import annotations

from collections.abc import AsyncIterator
import json
import logging
from typing import Any

import aiohttp

_LOGGER = logging.getLogger(__name__)


class BridgeError(Exception):
    """The bridge could not be reached or returned an error."""


class BridgeAuthError(BridgeError):
    """The token was rejected."""


class PiBridgeClient:
    """Talks to va-bridge running in (or next to) pi."""

    def __init__(self, session: aiohttp.ClientSession, url: str, token: str) -> None:
        """Initialize."""
        self._session = session
        self._url = url.rstrip("/")
        self._headers = {"Authorization": f"Bearer {token}"}

    async def _check(self, resp: aiohttp.ClientResponse) -> None:
        if resp.status == 401:
            raise BridgeAuthError("The pi bridge rejected the token")
        if resp.status >= 400:
            text = await resp.text()
            raise BridgeError(f"pi bridge returned HTTP {resp.status}: {text[:200]}")

    async def health(self) -> dict[str, Any]:
        """Return bridge info."""
        try:
            async with self._session.get(
                f"{self._url}/v1/health",
                headers=self._headers,
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                await self._check(resp)
                return await resp.json()
        except (aiohttp.ClientError, TimeoutError) as err:
            raise BridgeError(f"Cannot reach the pi bridge: {err}") from err

    async def _ndjson(self, resp: aiohttp.ClientResponse) -> AsyncIterator[dict[str, Any]]:
        async for raw in resp.content:
            line = raw.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                _LOGGER.debug("Ignoring malformed line from bridge: %s", line[:200])

    async def turn(self, request: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        """Run a conversation turn, yielding the bridge's events as they stream in."""
        try:
            async with self._session.post(
                f"{self._url}/v1/turn",
                headers=self._headers,
                json=request,
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=600),
            ) as resp:
                await self._check(resp)
                async for event in self._ndjson(resp):
                    yield event
        except (aiohttp.ClientError, TimeoutError) as err:
            raise BridgeError(f"Lost the connection to the pi bridge: {err}") from err

    async def abort(self, session_key: str) -> None:
        """Abort what the agent is doing in a session."""
        try:
            async with self._session.post(
                f"{self._url}/v1/abort",
                headers=self._headers,
                json={"session_key": session_key},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                await self._check(resp)
        except (aiohttp.ClientError, TimeoutError) as err:
            raise BridgeError(f"Cannot reach the pi bridge: {err}") from err

    async def events(self, since: int | None) -> AsyncIterator[dict[str, Any]]:
        """Stream background task events (never ends unless the connection drops)."""
        params = {} if since is None else {"since": str(since)}
        try:
            async with self._session.get(
                f"{self._url}/v1/events",
                headers=self._headers,
                params=params,
                # the bridge pings every 15 s
                timeout=aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=60),
            ) as resp:
                await self._check(resp)
                async for event in self._ndjson(resp):
                    yield event
        except (aiohttp.ClientError, TimeoutError) as err:
            raise BridgeError(f"Event stream from the pi bridge dropped: {err}") from err
