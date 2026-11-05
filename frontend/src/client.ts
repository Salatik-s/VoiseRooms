import { readResponse } from "./errors.ts";
declare global {
  interface Window {
    VoiceRoomsNative?: {
      callState: (active: boolean, microphone: boolean) => void;
      saveSession?: (token: string) => void;
      saveFile?: (name: string, base64: string, mime: string) => void;
    };
    Telegram?: {
      WebApp?: { initData?: string; ready: () => void; expand: () => void };
    };
  }
}
export const tg = window.Telegram?.WebApp;
export async function digest(value: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export const admissionProof = (key: string) =>
  digest("VoiceRooms admission v1:" + key);
let session = sessionStorage.getItem("vr-session") || "";
export async function headers(): Promise<Record<string, string>> {
  if (tg?.initData) return { "X-Telegram-Init-Data": tg.initData };
  if (!session) {
    const r = await fetch("/api/session");
    session = (await readResponse(r)).token;
    sessionStorage.setItem("vr-session", session);
    try {
      window.VoiceRoomsNative?.saveSession?.(session);
    } catch {
      /* Native persistence is optional in the browser. */
    }
  }
  return { Authorization: "Bearer " + session };
}
export async function api(
  path: string,
  body?: unknown,
  method = body ? "POST" : "GET",
) {
  const r = await fetch("/api" + path, {
    method,
    headers: { ...(await headers()), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return readResponse(r);
}
export const keyFor = (code: string) =>
  sessionStorage.getItem("vr-key-" + code) || "";
export const enc = (a: Uint8Array) =>
  btoa(String.fromCharCode(...a))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const dec = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
    c.charCodeAt(0),
  );
export function invite(code: string, key = keyFor(code)) {
  return (
    location.origin +
    "/?room=" +
    encodeURIComponent(code) +
    (key ? "#key=" + key : "")
  );
}
export type Info = {
  code: string;
  name: string;
  encrypted: boolean;
  participantCount?: number;
  isPersistent?: boolean;
  isActive?: boolean;
  isLocked?: boolean;
  maxParticipants?: number;
  reopensAt?: string | null;
};
export type Token = {
  token: string;
  livekitUrl: string;
  room: string;
  isAdmin: boolean;
  isServiceOwner?: boolean;
  microphoneBlocked?: boolean;
  identity: string;
  encrypted: boolean;
};
export type Message = {
  id: string;
  name: string;
  text?: string;
  file?: { id: number; name: string; iv: string };
  self?: boolean;
};

export function nativeCallState(active: boolean, microphone: boolean) {
  try {
    window.VoiceRoomsNative?.callState(active, microphone);
  } catch {
    /* Native lifecycle support must not interrupt a conversation. */
  }
}
export type Viewer = {
  isServiceOwner: boolean;
  isAnonymous: boolean;
  maxParticipantsLimit?: number;
};

export function clearSession() {
  session = "";
  sessionStorage.removeItem("vr-session");
  try {
    window.VoiceRoomsNative?.saveSession?.("");
  } catch {}
}
