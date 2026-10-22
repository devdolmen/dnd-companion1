// Thin fetch wrapper for the Tome & Table server API.
const CSRF = 'TomeAndTable';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': CSRF, Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    throw new ApiError(0, 'Cannot reach the server. Is it running?');
  }
  if (res.status === 204) return null;
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON body */ }
  if (!res.ok) {
    if (res.status === 401) document.dispatchEvent(new CustomEvent('tt:unauthorized'));
    throw new ApiError(res.status, data.error || data.detail || res.statusText || `HTTP ${res.status}`);
  }
  return data;
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body ?? {});
export const put = (path, body) => api('PUT', path, body ?? {});
export const del = (path) => api('DELETE', path);

// Download a server file through an anchor so the cookie travels with the request.
export function downloadUrl(path, filename) {
  const a = document.createElement('a');
  a.href = path; if (filename) a.download = filename;
  document.body.append(a); a.click(); a.remove();
}
