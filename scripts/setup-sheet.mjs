// One-shot: create the Google Sheet (4 tabs + header rows) with the service
// account, make it readable by link, and print the spreadsheet id.
//
//   node scripts/setup-sheet.mjs /path/to/service-account.json
//
import { readFileSync } from "node:fs";
import { createSign } from "node:crypto";

const saPath = process.argv[2];
if (!saPath) {
  console.error("usage: node scripts/setup-sheet.mjs <service-account.json>");
  process.exit(1);
}
const sa = JSON.parse(readFileSync(saPath, "utf8"));

const TABS = ["strikes", "ground", "casualties", "diplomacy"];
const HEADER = [
  "id", "first_seen_utc", "event_utc", "event_type", "headline", "summary",
  "location_name", "admin_region", "country", "lat", "lon", "confidence_tier",
  "actor_from", "actor_to", "source_outlet", "source_url", "killed_reported",
  "wounded_reported", "reported_by", "run_id",
];

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function token(scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: scopes.join(" "),
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claim}.${sig}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=" + encodeURIComponent(jwt),
  });
  if (!res.ok) throw new Error(`token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token;
}

const t = await token([
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
]);

// 1. create spreadsheet with the four tabs
const createRes = await fetch("https://sheets.googleapis.com/v4/spreadsheets", {
  method: "POST",
  headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
  body: JSON.stringify({
    properties: { title: "Ukraine War Live — event store" },
    sheets: TABS.map((title) => ({ properties: { title } })),
  }),
});
if (!createRes.ok) throw new Error(`create ${createRes.status}: ${await createRes.text()}`);
const ss = await createRes.json();
const id = ss.spreadsheetId;

// 2. write header rows
const data = TABS.map((tab) => ({ range: `${tab}!A1`, values: [HEADER] }));
const hdrRes = await fetch(
  `https://sheets.googleapis.com/v4/spreadsheets/${id}/values:batchUpdate`,
  {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ valueInputOption: "RAW", data }),
  },
);
if (!hdrRes.ok) throw new Error(`headers ${hdrRes.status}: ${await hdrRes.text()}`);

// 3. share: anyone with the link can view
const permRes = await fetch(
  `https://www.googleapis.com/drive/v3/files/${id}/permissions?supportsAllDrives=true`,
  {
    method: "POST",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" }),
  },
);
const shareOk = permRes.ok;
if (!shareOk) console.error(`share warning ${permRes.status}: ${await permRes.text()}`);

console.log(JSON.stringify({
  spreadsheetId: id,
  url: `https://docs.google.com/spreadsheets/d/${id}/edit`,
  link_sharing: shareOk ? "anyone-with-link: reader" : "FAILED — share manually",
}, null, 2));
