import { API_URL } from "./api";

export type Role = "user" | "admin";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
}

export interface AuthSession {
  token: string;
  expires_at: string;
  user: AuthUser;
}

export interface AdminSession {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: Role;
  signed_in_at: string;
  last_seen_at: string;
  expires_at: string;
  online: boolean;
  ip?: string | null;
  user_agent?: string | null;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  created_at: string;
  last_login_at?: string | null;
  last_seen_at?: string | null;
  login_count: number;
  signed_in: boolean;
  online: boolean;
  active_sessions: number;
}

export interface AdminOverview {
  total_users: number;
  signed_in_users: number;
  online_users: number;
  users: AdminUser[];
  sessions: AdminSession[];
}

/** Raised for 401 responses so callers can drop a stale session. */
export class UnauthorizedError extends Error {}

async function request<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, headers, ...rest } = init;
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...rest,
      headers: {
        ...(rest.body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
  } catch {
    throw new Error("Could not reach the server. Check your connection and try again.");
  }
  if (!response.ok) {
    let message = "Something went wrong. Please try again.";
    try {
      const body = await response.json();
      if (typeof body?.detail === "string") message = body.detail;
      else if (Array.isArray(body?.detail)) message = "Please check the details you entered.";
    } catch { /* Keep the fallback for non-JSON responses. */ }
    if (response.status === 401 && token) throw new UnauthorizedError(message);
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function register(name: string, email: string, password: string): Promise<AuthUser> {
  return request("/auth/register", { method: "POST", body: JSON.stringify({ name, email, password }) });
}

export function login(email: string, password: string): Promise<AuthSession> {
  return request("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
}

export function getMe(token: string): Promise<AuthUser> {
  return request("/auth/me", { token });
}

export function logout(token: string): Promise<void> {
  return request("/auth/logout", { method: "POST", token });
}

export function getAdminOverview(token: string): Promise<AdminOverview> {
  return request("/admin/overview", { token });
}

export function signOutSession(token: string, sessionId: string): Promise<void> {
  return request(`/admin/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", token });
}
