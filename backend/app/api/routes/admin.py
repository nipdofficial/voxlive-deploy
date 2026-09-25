from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.api.routes.auth import require_admin
from app.models.auth import AdminOverview, AdminSession, AdminUser, SessionRecord
from app.services.auth_service import auth_store, is_online

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


def _admin_session(session: SessionRecord) -> AdminSession:
    return AdminSession(
        id=session.id,
        user_id=session.user_id,
        name=session.name,
        email=session.email,
        role=session.role,
        signed_in_at=session.created_at,
        last_seen_at=session.last_seen_at,
        expires_at=session.expires_at,
        online=is_online(session),
        ip=session.ip,
        user_agent=session.user_agent,
    )


@router.get("/overview", response_model=AdminOverview)
async def overview() -> AdminOverview:
    sessions = [_admin_session(session) for session in await auth_store.list_sessions()]
    users: list[AdminUser] = []
    for user in await auth_store.list_users():
        own = [session for session in sessions if session.user_id == user.id]
        users.append(
            AdminUser(
                id=user.id,
                name=user.name,
                email=user.email,
                role=user.role,
                created_at=user.created_at,
                last_login_at=user.last_login_at,
                last_seen_at=max((s.last_seen_at for s in own), default=None),
                login_count=user.login_count,
                signed_in=bool(own),
                online=any(s.online for s in own),
                active_sessions=len(own),
            )
        )
    return AdminOverview(
        total_users=len(users),
        signed_in_users=sum(user.signed_in for user in users),
        online_users=sum(user.online for user in users),
        users=users,
        sessions=sessions,
    )


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def sign_out_session(session_id: str) -> Response:
    if not await auth_store.revoke_session(session_id):
        raise HTTPException(status_code=404, detail="Session not found")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
