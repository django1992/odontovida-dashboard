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

// Lista los nombres (títulos) de todas las pestañas del spreadsheet.
async function fetchSheetTitles(accessToken, sheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) {
    throw new Error("Error listando las pestañas del Sheets: " + JSON.stringify(json));
  }
  return (json.sheets || []).map((s) => s.properties.title);
}

// Lee el rango completo de UNA pestaña (por nombre) como valores SIN formatear
// (números crudos, no "$25.870").
async function fetchSheetValues(accessToken, sheetId, sheetTitle) {
  const escapedTitle = sheetTitle.replace(/'/g, "''");
  const range = `'${escapedTitle}'!A1:AZ2000`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(
    range
  )}?valueRenderOption=UNFORMATTED_VALUE`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Error leyendo la pestaña "${sheetTitle}": ` + JSON.stringify(json));
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
const DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/;

// Con valueRenderOption=UNFORMATTED_VALUE, Google devuelve las fechas como número de serie
// (días desde el 30/12/1899). Ej: 46023 = 01/01/2026. Convertimos ese número a fecha ISO.
const SHEETS_EPOCH_MS = Date.UTC(1899, 11, 30);
function isoFromSerial(n) {
  if (typeof n !== "number" || !isFinite(n)) return null;
  if (n < 43831 || n > 51500) return null; // solo fechas plausibles 2020-2041 (evita confundir montos con fechas)
  if (n % 1 !== 0) return null; // las fechas puras son enteros; decimales son montos/porcentajes
  const ms = SHEETS_EPOCH_MS + Math.round(n) * 86400000;
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

function norm(s) {
  return String(s == null ? "" : s)
    .replace(/\u00a0/g, " ") // espacios "non-breaking"
    .trim()
    .toLowerCase();
}

// Marcador que identifica una fila de encabezado de tabla diaria. Se acepta con o sin
// guion/espacio ("scr-%", "scr %", "scr%") para tolerar pequeñas variaciones de formato.
function looksLikeScrHeader(cellText) {
  const t = norm(cellText).replace(/[\s-]/g, "");
  return t === "scr%";
}

function toNum(v) {
  if (v === undefined || v === null || v === "") return 0;
  if (typeof v === "number") return v;
  const n = parseFloat(String(v).replace(/[^0-9.-]/g, ""));
  return isNaN(n) ? 0 : n;
}

function isoFromCell(v) {
  // Caso 1: número de serie de Google Sheets (lo que devuelve UNFORMATTED_VALUE para fechas).
  const fromSerial = isoFromSerial(v);
  if (fromSerial) return fromSerial;
  // Caso 2: texto tipo "01/01/26" o "01/01/2026".
  const m = DATE_RE.exec(String(v).trim());
  if (!m) return null;
  const [, dd, mm, yRaw] = m;
  const yyyy = yRaw.length === 2 ? `20${yRaw}` : yRaw;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

// Parsea las tablas diarias apiladas dentro de una pestaña: busca filas de encabezado
// (identificadas por una celda tipo "SCR-%"), mapea columnas por texto de encabezado
// (comparación flexible: sin tildes/mayúsculas no hace falta, se compara tal cual pero
// tolerando espacios raros), y luego lee filas siguientes mientras alguna columna tenga
// una fecha DD/MM/YY válida.
function parseDaily(rows) {
  const out = [];
  const seen = new Set();

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const hasScr = row.some((c) => looksLikeScrHeader(c));
    if (!hasScr) continue;

    // Mapear columnas de este bloque por texto de encabezado (comparación normalizada).
    const colOf = {};
    row.forEach((cell, idx) => {
      const text = norm(cell);
      const match = NEEDED_HEADERS.find((h) => norm(h) === text);
      if (match && colOf[match] === undefined) {
        colOf[match] = idx;
      }
    });
    if (Object.keys(colOf).length < 5) continue; // bloque no reconocido, seguir buscando

    // Leer filas siguientes hasta que ya no haya una fecha DD/MM/YY válida en las primeras columnas.
    let rr = r + 1;
    while (rr < rows.length) {
      const dataRow = rows[rr] || [];
      let iso = null;
      for (let c = 0; c < Math.min(4, dataRow.length); c++) {
        iso = isoFromCell(dataRow[c]);
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

// Nombre exacto de la pestaña con el registro fila-por-fila de pacientes.
const REGISTRY_TAB = "Registro de pacientes";

// Encuentra la agenda MÁS RECIENTE (mayor fecha en la columna "Agenda") en el registro de pacientes,
// y devuelve { nombre, agenda, cita } de esa fila. Columnas: G=Nombre y apellido, E=Agenda, F=Cita.
function parseUltimaAgenda(rows) {
  // 1) Ubicar la fila de encabezados (la que tiene "Nombre y apellido", "Agenda" y "Cita").
  let cols = {};
  let headerIdx = -1;
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r] || [];
    const texts = row.map((c) => norm(c));
    const hasNombre = texts.some((t) => t === norm("Nombre y apellido"));
    const hasAgenda = texts.some((t) => t === norm("Agenda"));
    const hasCita = texts.some((t) => t === norm("Cita"));
    if (hasNombre && hasAgenda && hasCita) {
      headerIdx = r;
      row.forEach((cell, idx) => {
        const t = norm(cell);
        if (t === norm("Nombre y apellido") && cols.nombre === undefined) cols.nombre = idx;
        if (t === norm("Agenda") && cols.agenda === undefined) cols.agenda = idx;
        if (t === norm("Cita") && cols.cita === undefined) cols.cita = idx;
      });
      break;
    }
  }
  if (headerIdx === -1 || cols.nombre === undefined || cols.agenda === undefined) return null;

  // 2) Recorrer las filas de datos y quedarnos con la de mayor fecha de agenda (con nombre válido).
  let best = null;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const agendaISO = isoFromCell(row[cols.agenda]);
    if (!agendaISO) continue;
    const nombre = String(row[cols.nombre] == null ? "" : row[cols.nombre]).trim();
    if (!nombre) continue;
    const citaISO = cols.cita !== undefined ? isoFromCell(row[cols.cita]) : null;
    // >= para que, ante empates de fecha, gane la fila más abajo (la ingresada más recientemente).
    if (!best || agendaISO >= best.agenda) {
      best = { nombre, agenda: agendaISO, cita: citaISO };
    }
  }
  return best;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
  try {
    const sheetId = process.env.SHEET_ID;
    if (!sheetId) throw new Error("Falta SHEET_ID en las variables de entorno.");
    const accessToken = await getAccessToken();

    const titles = await fetchSheetTitles(accessToken, sheetId);
    if (titles.length === 0) throw new Error("El Sheets no tiene ninguna pestaña visible.");

    let daily = [];
    const debugInfo = [];
    let registryRows = null;
    for (const title of titles) {
      const rows = await fetchSheetValues(accessToken, sheetId, title);
      if (title === REGISTRY_TAB) registryRows = rows;
      const found = parseDaily(rows);
      debugInfo.push({ pestaña: title, filas_leidas: rows.length, dias_encontrados: found.length });
      daily = daily.concat(found);
    }
    // Por si el mismo día aparece en más de una pestaña, nos quedamos con una sola entrada por fecha.
    const byDate = {};
    daily.forEach((d) => { byDate[d.d] = d; });
    daily = Object.values(byDate).sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));

    if (daily.length === 0) {
      throw new Error(
        "Se conectó a Google Sheets pero no se reconoció ninguna tabla diaria. Pestañas revisadas: " +
          JSON.stringify(debugInfo)
      );
    }

    // La última agenda es opcional: si algo falla al leer el registro, no rompemos el dashboard.
    let ultimaAgenda = null;
    try {
      if (registryRows) ultimaAgenda = parseUltimaAgenda(registryRows);
    } catch (e) {
      ultimaAgenda = null;
    }

    res.status(200).json({ ok: true, daily, ultimaAgenda, syncedAt: new Date().toISOString(), debug: debugInfo });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
};
