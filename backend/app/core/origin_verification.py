"""Optional CloudFront origin verification for both HTTP and WebSockets."""
import hmac

from starlette.responses import PlainTextResponse


class OriginVerificationMiddleware:
    def __init__(self, app, secret: str | None = None):
        self.app = app
        self.secret = secret.encode("utf-8") if secret else None

    async def __call__(self, scope, receive, send):
        if self.secret is not None and scope["type"] in ("http", "websocket"):
            values = [value for name, value in scope.get("headers", [])
                      if name.lower() == b"x-voxlive-origin"]
            valid = len(values) == 1 and hmac.compare_digest(values[0], self.secret)
            if not valid:
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 1008})
                else:
                    await PlainTextResponse("Forbidden", status_code=403)(scope, receive, send)
                return
        await self.app(scope, receive, send)
