import { readResponse } from "./errors.ts";
declare global {
  interface Window {
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
};
export type Token = {
  token: string;
  livekitUrl: string;
  room: string;
  isAdmin: boolean;
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
