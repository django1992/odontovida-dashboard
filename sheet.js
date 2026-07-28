// /api/sheet.js — Vercel Serverless Function
//
// Lee el Google Sheets de Odontovida usando una cuenta de servicio de Google
// (la hoja NO necesita ser pública; solo se comparte con el email de la
// cuenta de servicio, igual que se comparte con una persona).
//
// Variables de entorno requeridas (configúralas en Vercel → Project Settings → Environment Variables):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL   -> el "client_email" del JSON de la cuenta de servicio
//   GOOGLE_PRIVATE_KEY             -> el "private_key" del JSON (pega el bloque completo, con \n literales)
//   SHEET_ID                       -> 1gLQ6J-3TTBzPwNB3QOLU_HG07uFH1ozuvxecQwiA-f4
//
// No usa ninguna librería externa (googleapis, jsonwebtoken, etc.) para no depender
// de instalación de paquetes: firma el JWT a mano con el módulo "crypto" de Node.

const crypto = require("crypto");

const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Obtiene un access_token OAuth2 firmando un JWT con la clave privada de la cuenta de servicio.
async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !privateKey) {
    throw new Error("Faltan GOOGLE_SERVICE_ACCOUNT_EMAIL o GOOGLE_PRIVATE_KEY en las variables de entorno.");
  }
  // Si la clave viene con \n escapados (común al pegarla en Vercel), los convertimos a saltos reales.
  privateKey = privateKey.replace(/\\n/g, "\n");

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKey);
  const jwt = `${signingInput}.${base64url(signature)}`;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error("No se pudo obtener access_token de Google: " + JSON.stringify(json));
  }
  return json.access_token;
}

// Lee el rango completo de la primera hoja como valores SIN formatear (números crudos, no "$25.870").
async function fetchSheetValues(accessToken, sheetId) {
  const range = "A1:AZ2000";
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
    range
  )}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) {
    throw new Error("Error leyendo el Sheets: " + JSON.stringify(json));
  }
  return json.values || [];
}

const NEEDED_HEADERS = [
  "Inversión",
  "Impresiones",
  "Clicks",
  "CMI",
  "Agendas",
  "Citas",
  "Asistencias",
  "Unidades",
  "Ventas",
  "Facturado",
];
const HEADER_TO_KEY = {
  "Inversión": "inv",
  "Impresiones": "imp",
  "Clicks": "clk",
  "CMI": "cmi",
  "Agendas": "ag",
  "Citas": "ci",
  "Asistencias": "asi",
  "Unidades": "cie",
  "Ventas": "ven",
  "Facturado": "fac",
};
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;

function toNum(v) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function isoFromDDMMYY(s) {
  const m = DATE_RE.exec(String(s).trim());
  if (!m) return null;
  const [, dd, mm, yy] = m;
  return `20${yy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Parsea las tablas diarias apiladas dentro de la hoja: busca filas de encabezado
// (identificadas por contener "SCR-%"), mapea columnas por texto de encabezado,
// y luego lee filas siguientes mientras alguna columna tenga una fecha DD/MM/YY válida.
function parseDaily(rows) {
  const out = [];
  const seen = new Set();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const hasScr = row.some((c) => String(c).trim() === "SCR-%");
    if (!hasScr) continue;

    // Mapear columnas de este bloque por texto de encabezado.
    const colOf = {};
    row.forEach((cell, idx) => {
      const text = String(cell).trim();
      if (NEEDED_HEADERS.includes(text) && colOf[text] === undefined) {
        colOf[text] = idx;
      }
    });
    if (Object.keys(colOf).length < 5) continue; // bloque no reconocido, seguir buscando

    // Leer filas siguientes hasta que ya no haya una fecha DD/MM/YY válida en las primeras columnas.
    let rr = r + 1;
    while (rr < rows.length) {
      const dataRow = rows[rr] || [];
      let iso = null;
      for (let c = 0; c < Math.min(4, dataRow.length); c++) {
        iso = isoFromDDMMYY(dataRow[c]);
        if (iso) break;
      }
      if (!iso) break; // fin de este bloque de días

      if (!seen.has(iso)) {
        seen.add(iso);
        const entry = { d: iso, inv: 0, imp: 0, clk: 0, cmi: 0, ag: 0, ci: 0, asi: 0, cie: 0, ven: 0, fac: 0 };
        NEEDED_HEADERS.forEach((h) => {
          if (colOf[h] !== undefined) {
            entry[HEADER_TO_KEY[h]] = toNum(dataRow[colOf[h]]);
          }
        });
        out.push(entry);
      }
      rr++;
    }
  }

  out.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error("Falta SHEET_ID en las variables de entorno.");
    const accessToken = await getAccessToken();
    const rows = await fetchSheetValues(accessToken, sheetId);
    const daily = parseDaily(rows);
    if (daily.length === 0) {
      throw new Error("Se conectó a Google Sheets pero no se reconoció ninguna tabla diaria. Revisa la estructura de la hoja.");
    }
    res.status(200).json({ ok: true, daily, syncedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
