import { getStore } from "@netlify/blobs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

const STORE_NAME = "never-go-alone-live-v3";
const RECORD_PREFIX = "interest/";
const MAX_REQUEST_BYTES = 8192;
const MAX_PUBLIC_MEMBERS = 100;
const MAX_DESCRIPTION_LENGTH = 320;
const MAX_PASSIONS_LENGTH = 180;
const MAX_NATIONALITY_LENGTH = 70;
const MAX_LAUNCH_FEEDBACK_LENGTH = 600;
const EVENT_ID_PATTERN = /^nga-(paris|lyon|lille|marseille|bordeaux|nantes|strasbourg)-[a-z0-9-]{3,170}$/;
const GENDERS = new Set(["woman", "man", "unspecified"]);
const GOOGLE_FORM_RESPONSE_URL = process.env.GOOGLE_FORM_RESPONSE_URL || "https://docs.google.com/forms/d/e/1FAIpQLSeoXqtJ7WOj_NkDK2kqRJa8Fey_msSvvU62978PLLdd5iaNNg/formResponse";
const LAUNCH_INTEREST_RESPONSES = new Map([
  ["very", "Very interested, I’d use it right away"],
  ["interested", "Interested, I’d like to try it"],
  ["curious", "Curious, but not sure yet"]
]);
const LAUNCH_CHAT_RESPONSES = new Map([
  ["yes", "Yes, feel free to contact me"],
  ["no", "No, thanks"]
]);
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

function publicProfileText(record, key, maximumLength) {
  return record && typeof record[key] === "string" ? cleanText(record[key], maximumLength) : "";
}

function cleanOptionalPublicText(value, maximumLength, label) {
  if (value === undefined || value === null) return { provided: false, value: "" };
  if (typeof value !== "string") throw new HttpError(400, label + " invalide.");

  // Keep profile text readable and safe to render, even if a client bypasses
  // the form's maxlength attributes. The front end still escapes this text.
  const normalized = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .trim()
    .replace(/\s+/g, " ");
  if (normalized.length > maximumLength || /[<>]/.test(normalized)) {
    throw new HttpError(400, label + " est trop long ou contient des caractères non autorisés.");
  }
  return { provided: true, value: normalized };
}

function cleanRequiredPublicText(value, maximumLength, label) {
  const text = cleanOptionalPublicText(value, maximumLength, label);
  if (!text.provided || !text.value) throw new HttpError(400, label + " est requis.");
  return text.value;
}

function cleanAge(value) {
  const age = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{1,2}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isInteger(age) || age < 18 || age > 30) {
    throw new HttpError(400, "L’âge doit être compris entre 18 et 30 ans.");
  }
  return age;
}

function launchResponseValue(value, choices, label) {
  const normalized = cleanText(value, 30);
  const response = choices.get(normalized);
  if (!response) throw new HttpError(400, label + " invalide.");
  return response;
}

async function submitLaunchQuestionnaire(email, interest, feedback, chat) {
  const body = new URLSearchParams({
    "entry.2059906264": email,
    "entry.725885935": interest,
    "entry.2046482610": feedback,
    "entry.1936886010": chat
  });

  let response;
  try {
    response = await fetch(GOOGLE_FORM_RESPONSE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body,
      redirect: "follow"
    });
  } catch {
    throw new HttpError(502, "Le formulaire de lancement est indisponible. Réessaie dans un instant.");
  }
  if (!response.ok) {
    throw new HttpError(502, "Le formulaire de lancement n’a pas pu être envoyé. Réessaie dans un instant.");
  }
}

function isGender(value) {
  return typeof value === "string" && GENDERS.has(value);
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
    // Legacy profiles are retained even though they predate these fields.
    age: Number.isInteger(record.age) ? record.age : null,
    nationality: publicProfileText(record, "nationality", MAX_NATIONALITY_LENGTH),
    // Profiles created before gender was shared publicly remain readable.
    gender: isGender(record.gender) ? record.gender : "unspecified",
    description: publicProfileText(record, "description", MAX_DESCRIPTION_LENGTH),
    passions: publicProfileText(record, "passions", MAX_PASSIONS_LENGTH),
    avatarKey: Number(record.avatarKey),
    createdAt: String(record.createdAt)
  };
}

function validRecord(record) {
  return record && typeof record === "object" &&
    typeof record.id === "string" &&
    typeof record.firstName === "string" && record.firstName.length > 0 &&
    typeof record.activity === "string" && record.activity.length > 0 &&
    (!Object.hasOwn(record, "age") || (Number.isInteger(record.age) && record.age >= 18 && record.age <= 30)) &&
    (!Object.hasOwn(record, "nationality") || typeof record.nationality === "string") &&
    (!Object.hasOwn(record, "gender") || isGender(record.gender)) &&
    (!Object.hasOwn(record, "description") || typeof record.description === "string") &&
    (!Object.hasOwn(record, "passions") || typeof record.passions === "string") &&
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
  const age = cleanAge(payload.age);
  const nationality = cleanRequiredPublicText(payload.nationality, MAX_NATIONALITY_LENGTH, "Nationalité");
  const submittedDescription = cleanOptionalPublicText(payload.description, MAX_DESCRIPTION_LENGTH, "Description");
  const submittedPassions = cleanOptionalPublicText(payload.passions, MAX_PASSIONS_LENGTH, "Passions");
  const launchInterest = launchResponseValue(payload.launchInterest, LAUNCH_INTEREST_RESPONSES, "Niveau d’intérêt");
  const launchFeedback = cleanRequiredPublicText(payload.launchFeedback, MAX_LAUNCH_FEEDBACK_LENGTH, "Retour");
  const launchChat = launchResponseValue(payload.launchChat, LAUNCH_CHAT_RESPONSES, "Disponibilité");
  const namePattern = /^[\p{L}][\p{L}\p{M}' -]{1,49}$/u;
  const firstNamePattern = /^[\p{L}][\p{L}\p{M}' -]{1,29}$/u;
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!firstNamePattern.test(firstName) || !namePattern.test(lastName) || !emailPattern.test(email) || activity.length < 2 || /[<>]/.test(activity)) {
    throw new HttpError(400, "Vérifie ton prénom, ton nom, ton e-mail et ton activité.");
  }
  if (!GENDERS.has(gender)) {
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
  const questionnaireAlreadySent = validRecord(existing) && existing.launchQuestionnaireSubmitted === true;

  // The launch questionnaire is submitted before the profile is persisted.
  // Therefore a visitor never appears in a group without their response being
  // received by the Google Form. The marker avoids duplicate responses when a
  // person updates an existing profile for the same event.
  if (!questionnaireAlreadySent) {
    await submitLaunchQuestionnaire(email, launchInterest, launchFeedback, launchChat);
  }
  const now = new Date().toISOString();
  const record = {
    id: validRecord(existing) ? existing.id : randomUUID(),
    firstName,
    activity,
    age,
    nationality,
    gender,
    // When an older client re-submits an interest without these newer fields,
    // keep the profile details that the person had already shared.
    description: submittedDescription.provided && submittedDescription.value
      ? submittedDescription.value
      : publicProfileText(existing, "description", MAX_DESCRIPTION_LENGTH),
    passions: submittedPassions.provided && submittedPassions.value
      ? submittedPassions.value
      : publicProfileText(existing, "passions", MAX_PASSIONS_LENGTH),
    launchQuestionnaireSubmitted: true,
    avatarKey: avatarKeyFrom(emailHash, gender),
    withdrawalHash,
    createdAt: validRecord(existing) ? existing.createdAt : now,
    updatedAt: now
  };

  // Raw e-mail and surname never enter the persistent store. The selected
  // gender, age and nationality are public only after explicit consent.
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
