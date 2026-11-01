"""Require authentication on every HTTP route and expose only inference/health."""
import hmac
import os

ALLOWED = {("GET", "/health"), ("GET", "/v1/models"), ("POST", "/v1/chat/completions")}


class BearerGate:
    def __init__(self, app):
        self.app = app
        key = os.environ.get("VLLM_API_KEY", "")
        if len(key) < 32 or key.startswith("__"):
            raise ValueError("A fresh VLLM_API_KEY is required")
        self.expected = ("Bearer " + key).encode()

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            return await send({"type": "websocket.close", "code": 1008})
        if scope["type"] != "http":
            return
        auth = [v for k, v in scope.get("headers", []) if k.lower() == b"authorization"]
        valid = len(auth) == 1 and hmac.compare_digest(auth[0], self.expected)
        status = 401 if not valid else (404 if (scope["method"], scope["path"]) not in ALLOWED else None)
        if status:
            body = b'{"error":"unauthorized"}' if status == 401 else b'{"error":"not_found"}'
            await send({"type": "http.response.start", "status": status,
                        "headers": [(b"content-type", b"application/json"), (b"cache-control", b"no-store")]})
            return await send({"type": "http.response.body", "body": body})
        return await self.app(scope, receive, send)
