from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response, status

from app.models.auth import (
    AuthUser,
    LoginRequest,
    LoginResponse,
    QRApproveRequest,
    QRStartResponse,
    QRStatusResponse,
    RegisterRequest,
    Role,
    SessionRecord,
)
from app.services.auth_service import AuthError, auth_store

router = APIRouter(prefix="/auth", tags=["auth"])


def _bearer_token(authorization: str | None) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="Sign in required")
    return token.strip()


async def current_session(authorization: str | None = Header(default=None)) -> SessionRecord:
    session = await auth_store.authenticate(_bearer_token(authorization))
    if session is None:
        raise HTTPException(status_code=401, detail="Your session has expired. Sign in again.")
    return session


async def require_admin(session: SessionRecord = Depends(current_session)) -> SessionRecord:
    if session.role != Role.admin:
        raise HTTPException(status_code=403, detail="Administrator access required")
    return session


def _as_user(session: SessionRecord) -> AuthUser:
    return AuthUser(id=session.user_id, name=session.name, email=session.email, role=session.role)


@router.post("/register", response_model=AuthUser, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterRequest) -> AuthUser:
    try:
        return await auth_store.register(body.name, body.email, body.password)
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc


@router.post("/login", response_model=LoginResponse)
async def login(body: LoginRequest, request: Request) -> LoginResponse:
    try:
        token, session = await auth_store.login(
            body.email,
            body.password,
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return LoginResponse(token=token, expires_at=session.expires_at, user=_as_user(session))


@router.post("/qr/start", response_model=QRStartResponse)
async def start_qr_login() -> QRStartResponse:
    token, expires_at = await auth_store.start_qr_login()
    return QRStartResponse(token=token, expires_at=expires_at)


@router.post("/qr/approve", status_code=status.HTTP_204_NO_CONTENT)
async def approve_qr_login(body: QRApproveRequest, request: Request) -> Response:
    try:
        await auth_store.approve_qr_login(
            body.token,
            body.email,
            body.password,
            ip=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent"),
        )
    except AuthError as exc:
        raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/qr/status", response_model=QRStatusResponse)
async def qr_login_status(token: str = Query(min_length=20, max_length=256)) -> QRStatusResponse:
    qr_status, expires_at, session_token, session = await auth_store.qr_login_status(token)
    return QRStatusResponse(
        status=qr_status,
        token=session_token,
        expires_at=session.expires_at if session else expires_at,
        user=_as_user(session) if session else None,
    )


@router.get("/me", response_model=AuthUser)
async def me(session: SessionRecord = Depends(current_session)) -> AuthUser:
    """Return the signed-in user. Clients also call this as an activity heartbeat."""
    return _as_user(session)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(authorization: str | None = Header(default=None)) -> Response:
    await auth_store.logout(_bearer_token(authorization))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
