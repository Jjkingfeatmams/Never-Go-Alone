import { getStore } from "@netlify/blobs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const STORE_NAME = "never-go-alone-live-v3";
const RECORD_PREFIX = "interest/";
const MAX_REQUEST_BYTES = 4096;
const MAX_PUBLIC_MEMBERS = 100;
const EVENT_ID_PATTERN = /^nga-(paris|lyon|lille|marseille|bordeaux|nantes|strasbourg)-[a-z0-9-]{3,170}$/;
const submissionWindows = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow"
    }
  });
}

function cleanText(value, maximumLength) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, maximumLength) : "";
}

function assertEventId(value) {
  const eventId = cleanText(value, 180);
  if (!EVENT_ID_PATTERN.test(eventId)) throw new HttpError(400, "Événement invalide.");
  return eventId;
}

function secret() {
  // NETLIFY_SITE_ID is injected into Functions. A project owner can also set
  // INTEREST_HASH_SECRET in Netlify for a private, stable HMAC key.
  return process.env.INTEREST_HASH_SECRET || process.env.NETLIFY_SITE_ID || "never-go-alone-v3-prototype";
}

function hmacHex(value) {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function avatarKeyFrom(emailHash, gender) {
  const options = {
    woman: [0, 2, 4, 6, 8, 10],
    man: [1, 3, 5, 7, 9, 11],
    unspecified: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  };
  const palette = options[gender] || options.unspecified;
  const number = Number.parseInt(emailHash.slice(0, 8), 16) || 0;
  return palette[number % palette.length];
}

function interestStore() {
  // Strong reads make a newly registered profile immediately visible to the
  // next visitor, rather than waiting for an edge-cache refresh.
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function recordKey(eventId, emailHash) {
  return RECORD_PREFIX + eventId + "/" + emailHash;
}

function publicMember(record) {
  return {
    id: String(record.id),
    firstName: String(record.firstName),
    activity: String(record.activity),
    avatarKey: Number(record.avatarKey),
    createdAt: String(record.createdAt)
  };
}

function validRecord(record) {
  return record && typeof record === "object" &&
    typeof record.id === "string" &&
    typeof record.firstName === "string" && record.firstName.length > 0 &&
    typeof record.activity === "string" && record.activity.length > 0 &&
    Number.isInteger(Number(record.avatarKey)) &&
    typeof record.createdAt === "string";
}

function allowSubmission(request) {
  const forwarded = request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for") || "anonymous";
  const address = forwarded.split(",")[0].trim() || "anonymous";
  const now = Date.now();
  const cutoff = now - 10 * 60 * 1000;
  const attempts = (submissionWindows.get(address) || []).filter((time) => time > cutoff);
  if (attempts.length >= 8) return false;
  attempts.push(now);
  submissionWindows.set(address, attempts);
  if (submissionWindows.size > 5000) submissionWindows.clear();
  return true;
}

async function readJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw new HttpError(413, "Demande trop volumineuse.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REQUEST_BYTES) throw new HttpError(413, "Demande trop volumineuse.");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Données de formulaire invalides.");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "Données de formulaire invalides.");
  }
  return payload;
}

async function eventSnapshot(eventId) {
  const store = interestStore();
  const { blobs } = await store.list({ prefix: RECORD_PREFIX + eventId + "/" });
  const values = await Promise.all(blobs.map((blob) => store.get(blob.key, { type: "json" })));
  const members = values
    .filter(validRecord)
    .map(publicMember)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return { eventId, count: members.length, members: members.slice(0, MAX_PUBLIC_MEMBERS) };
}

async function listInterestCounts() {
  const { blobs } = await interestStore().list({ prefix: RECORD_PREFIX });
  const counts = {};
  for (const blob of blobs) {
    const relativeKey = blob.key.slice(RECORD_PREFIX.length);
    const eventId = relativeKey.slice(0, relativeKey.indexOf("/"));
    if (EVENT_ID_PATTERN.test(eventId)) counts[eventId] = (counts[eventId] || 0) + 1;
  }
  return json({ counts });
}

async function listEventInterests(rawEventId) {
  return json(await eventSnapshot(assertEventId(rawEventId)));
}

async function createInterest(request) {
  if (!allowSubmission(request)) throw new HttpError(429, "Trop de demandes. Réessaie dans quelques minutes.");
  const payload = await readJson(request);
  if (cleanText(payload.website, 200)) throw new HttpError(400, "Données de formulaire invalides.");

  const eventId = assertEventId(payload.eventId);
  const firstName = cleanText(payload.firstName, 30);
  const lastName = cleanText(payload.lastName, 50);
  const email = cleanText(payload.email, 254).toLowerCase();
  const activity = cleanText(payload.activity, 80);
  const gender = cleanText(payload.gender, 20) || "unspecified";
  const namePattern = /^[\p{L}][\p{L}\p{M}' -]{1,49}$/u;
  const firstNamePattern = /^[\p{L}][\p{L}\p{M}' -]{1,29}$/u;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!firstNamePattern.test(firstName) || !namePattern.test(lastName) || !emailPattern.test(email) || activity.length < 2 || /[<>]/.test(activity)) {
    throw new HttpError(400, "Vérifie ton prénom, ton nom, ton e-mail et ton activité.");
  }
  if (!Object.hasOwn({ woman: true, man: true, unspecified: true }, gender)) {
    throw new HttpError(400, "Genre invalide.");
  }
  if (payload.adult !== true || payload.publicConsent !== true || payload.contactConsent !== true) {
    throw new HttpError(400, "Les consentements requis doivent être confirmés.");
  }

  const emailHash = hmacHex(email);
  const withdrawalToken = hmacHex("withdraw:" + eventId + ":" + email);
  const withdrawalHash = hmacHex(withdrawalToken);
  const key = recordKey(eventId, emailHash);
  const store = interestStore();
  const existing = await store.get(key, { type: "json" });
  const now = new Date().toISOString();
  const record = {
    id: validRecord(existing) ? existing.id : randomUUID(),
    firstName,
    activity,
    avatarKey: avatarKeyFrom(emailHash, gender),
    withdrawalHash,
    createdAt: validRecord(existing) ? existing.createdAt : now,
    updatedAt: now
  };

  // Raw e-mail, surname and gender never enter the persistent store.
  await store.setJSON(key, record);
  const snapshot = await eventSnapshot(eventId);
  return json(Object.assign(snapshot, { member: publicMember(record), withdrawToken: withdrawalToken }));
}

async function withdrawInterest(request) {
  const payload = await readJson(request);
  const eventId = assertEventId(payload.eventId);
  const token = cleanText(payload.token, 200);
  if (token.length < 20) throw new HttpError(400, "Lien de retrait invalide.");

  const store = interestStore();
  const tokenHash = hmacHex(token);
  const { blobs } = await store.list({ prefix: RECORD_PREFIX + eventId + "/" });
  const matches = await Promise.all(blobs.map(async (blob) => ({ key: blob.key, record: await store.get(blob.key, { type: "json" }) })));
  const matchingRecord = matches.find((entry) => validRecord(entry.record) && typeof entry.record.withdrawalHash === "string" && constantTimeEqual(entry.record.withdrawalHash, tokenHash));
  if (!matchingRecord) throw new HttpError(404, "Ce profil a déjà été retiré ou n’est plus disponible.");

  await store.delete(matchingRecord.key);
  return json(await eventSnapshot(eventId));
}

function isSameOrigin(request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

function requestPath(request) {
  return new URL(request.url).pathname;
}

export default async function liveInterest(request) {
  if (!isSameOrigin(request)) return json({ error: "Origine non autorisée." }, 403);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

  try {
    const path = requestPath(request);
    if (request.method === "GET" && path === "/api/interest-counts") return await listInterestCounts();
    const eventMatch = path.match(/^\/api\/events\/([^/]+)\/interests$/);
    if (request.method === "GET" && eventMatch) return await listEventInterests(decodeURIComponent(eventMatch[1]));
    if (request.method === "POST" && path === "/api/interests") return await createInterest(request);
    if (request.method === "POST" && path === "/api/interests/withdraw") return await withdrawInterest(request);
    return json({ error: "Route introuvable." }, 404);
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message }, error.status);
    return json({ error: "Le service live rencontre un problème. Réessaie dans un instant." }, 500);
  }
}

export const config = {
  path: "/api/*",
  method: ["GET", "POST", "OPTIONS"]
};
