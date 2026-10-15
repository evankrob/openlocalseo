export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

const WORKSPACE_KEY = "olseo_workspace";
export const getWorkspaceId = () => localStorage.getItem(WORKSPACE_KEY);
export const setWorkspaceId = (id: string) => localStorage.setItem(WORKSPACE_KEY, id);

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const workspace = getWorkspaceId();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(workspace ? { "x-workspace-id": workspace } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = json?.error ?? { code: "INTERNAL_ERROR", message: res.statusText };
    throw new ApiError(err.code, err.message, res.status);
  }
  return json as T;
}

export const get = <T,>(path: string) => api<T>("GET", path);
export const post = <T,>(path: string, body?: unknown) => api<T>("POST", path, body ?? {});
export const put = <T,>(path: string, body: unknown) => api<T>("PUT", path, body);
export const patch = <T,>(path: string, body: unknown) => api<T>("PATCH", path, body);
export const del = <T,>(path: string) => api<T>("DELETE", path);
