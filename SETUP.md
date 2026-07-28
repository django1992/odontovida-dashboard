# Poner el dashboard en vivo — guía paso a paso

Este proyecto tiene 2 partes:
- `index.html` → el panel visual (lo que ve tu socio)
- `api/sheet.js` → una función que corre en el servidor de Vercel, lee tu Google Sheets con una
  **cuenta de servicio** (no hace falta hacer pública la hoja) y le devuelve los datos a `index.html`

## Paso 1 — Crear la cuenta de servicio en Google Cloud

1. Ve a https://console.cloud.google.com/ (con tu cuenta de Google).
2. Si no tienes un proyecto, crea uno (arriba a la izquierda → "Nuevo proyecto"). Cualquier nombre sirve.
3. En el buscador de arriba, escribe **"Google Sheets API"** → ábrela → botón **Habilitar**.
4. Ve a **"APIs y servicios" → "Credenciales"** (menú de la izquierda).
5. **"+ Crear credenciales" → "Cuenta de servicio"**.
6. Ponle un nombre (ej: `odontovida-dashboard`) → **Crear y continuar** → **Listo** (los pasos de permisos de rol se pueden saltar).
7. En la lista de cuentas de servicio, haz clic en la que acabas de crear.
8. Pestaña **"Claves"** → **"Agregar clave" → "Crear clave nueva"** → tipo **JSON** → **Crear**.
   Esto descarga un archivo `.json` a tu computador. **Guárdalo, lo necesitas en el Paso 3.**
9. Copia el email de la cuenta de servicio (se ve como `algo@tu-proyecto.iam.gserviceaccount.com`,
   lo encuentras en la misma pantalla o dentro del JSON como `"client_email"`).

## Paso 2 — Compartir tu Google Sheets con esa cuenta (sigue siendo privado)

1. Abre tu Google Sheets de Odontovida.
2. Botón **"Compartir"** (arriba a la derecha).
3. Pega el email de la cuenta de servicio (el que copiaste en el paso anterior).
4. Dale rol **"Lector"** (Viewer) → **Enviar/Compartir**.

Con esto, solo esa cuenta de servicio (y las personas que ya tenían acceso) pueden leer la hoja.
No la hiciste pública.

## Paso 3 — Subir el proyecto a Vercel

1. Ve a **vercel.com/new**.
2. Arrastra **toda esta carpeta** (`odontovida-dashboard`, con `index.html`, la carpeta `api/` y `package.json` adentro) al recuadro de "drag and drop your project... or a folder".
3. Vercel va a detectar `api/sheet.js` como una función serverless automáticamente. Dale **Deploy**.

## Paso 4 — Configurar las variables de entorno

1. En el proyecto ya creado en Vercel, ve a **Settings → Environment Variables**.
2. Agrega estas 3 variables:

   | Nombre | Valor |
   |---|---|
   | `SHEET_ID` | `1gLQ6J-3TTBzPwNB3QOLU_HG07uFH1ozuvxecQwiA-f4` |
   | `GOOGLE_SERVICE_ACCOUNT_EMAIL` | el `client_email` del JSON descargado |
   | `GOOGLE_PRIVATE_KEY` | el `private_key` completo del JSON descargado (incluye las líneas `-----BEGIN PRIVATE KEY-----` y `-----END PRIVATE KEY-----`) |

   Para `GOOGLE_PRIVATE_KEY`: abre el `.json` descargado, copia el valor completo del campo `"private_key"` (incluyendo los `\n` tal cual aparecen, o si tu editor los muestra como saltos de línea reales, está bien igual — el código maneja ambos casos).

3. Después de guardar las variables, ve a **Deployments** → en el último deploy, menú de tres puntos → **Redeploy** (para que tome las variables nuevas).

## Paso 5 — Probar

Abre la URL de tu proyecto (`tu-proyecto.vercel.app`). Deberías ver, en la esquina superior derecha,
un indicador **"● En vivo · sync justo ahora"**. Si en cambio ves **"● Datos guardados (sin conexión en vivo)"**,
pasa el mouse sobre ese texto para ver el mensaje de error, y revisa:

- ¿Compartiste el Sheets con el email exacto de la cuenta de servicio? (Paso 2)
- ¿Las 3 variables de entorno están bien copiadas, sin espacios de más? (Paso 4)
- ¿Hiciste "Redeploy" después de guardar las variables?

Si después de revisar esto sigue sin funcionar, copia el mensaje de error (el texto que aparece al
pasar el mouse sobre el indicador amarillo/rojo) y compártelo — con eso se puede diagnosticar exactamente
qué falló.

## Nota sobre la estructura de la hoja

La función `api/sheet.js` busca automáticamente, dentro de tu Sheets, las tablas diarias
(las que tienen columnas como "Inversión", "Agendas", "Citas", etc. y una fila por día). No depende
de que sea exactamente enero-julio: si agregas datos de agosto en la misma hoja con el mismo formato,
el dashboard los va a mostrar solos, sin que yo tenga que tocar nada.
