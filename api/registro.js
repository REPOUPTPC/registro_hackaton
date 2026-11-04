const TURSO_HTTP_URL = (process.env.TURSO_DATABASE_URL || 'https://hackaton-repouptpc.aws-us-east-2.turso.io')
  .replace(/^libsql:\/\//, 'https://');

const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN ||
  'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTM2NTA4MTksImlkIjoiMDFhMTlkZWItNTUwMS03MDIxLWI5NmItMjZhNjEzYWRmYTllIiwia2lkIjoicW5PTlFQTFFWTXAyV0NUYmczNnZZTXN3R0Vwbm4wcFZDVTRlRnpvYllhWSIsInJpZCI6Ijc4NjRiZDNiLWJhMzktNGMzMS05NzNmLTZiN2ZjZjVkMjFiMyJ9.SfCIBdTluEOsuktXahLWl3WKnQnqsfRinYeU_oBJ9KvODp3WpMt2EupEiYxmOYNAXfN_AhK1cVQmY7hkzNG5BQ';

const PNF_CATALOG = {
  1: 'PT en Mecánica Térmica',
  2: 'PT en Mecánica Automotriz',
  3: 'PNF en Materiales Industriales',
  4: 'PNF en Mantenimiento',
  5: 'PNF en Mecánica',
  6: 'PNF en Turismo',
  7: 'PNF en Informática',
  8: 'PNF en Distribución y Logística'
};

async function executeTursoPipeline(requests) {
  const response = await fetch(`${TURSO_HTTP_URL}/v2/pipeline`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TURSO_AUTH_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ requests: [...requests, { type: 'close' }] })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error de conexión con Turso (${response.status}): ${errorText}`);
  }

  return response.json();
}

module.exports = async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Consulta por cédula (GET /api/registro?cedula=...)
  if (req.method === 'GET') {
    const rawCedula = String(req.query?.cedula || '').replace(/\D/g, '');
    if (!rawCedula) {
      return res.status(400).json({ ok: false, message: 'Por favor ingresa un número de cédula válido.' });
    }

    try {
      const data = await executeTursoPipeline([
        {
          type: 'execute',
          stmt: {
            sql: 'SELECT cedula, nombre_completo, telefono, correo_electronico, pnf_id, pnf_nombre, fecha_registro FROM participantes WHERE cedula = ? LIMIT 1;',
            args: [{ type: 'text', value: rawCedula }]
          }
        }
      ]);

      const resultObj = data?.results?.[0];
      if (resultObj?.type === 'error') {
        throw new Error(resultObj.error?.message || 'Error consultando base de datos');
      }

      const rows = resultObj?.response?.result?.rows || [];
      if (rows.length === 0) {
        return res.status(404).json({
          ok: false,
          registered: false,
          message: 'Esta cédula aún no se encuentra registrada para el certificado.'
        });
      }

      const r = rows[0];
      return res.status(200).json({
        ok: true,
        registered: true,
        participante: {
          cedula: r[0]?.value,
          nombre_completo: r[1]?.value,
          telefono: r[2]?.value,
          correo_electronico: r[3]?.value,
          pnf_id: Number(r[4]?.value),
          pnf_nombre: r[5]?.value,
          fecha_registro: r[6]?.value
        }
      });
    } catch (err) {
      return res.status(500).json({ ok: false, message: 'Error al verificar registro.', detail: err.message });
    }
  }

  // Registro de participante (POST /api/registro)
  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const cedulaClean = String(body.cedula || '').replace(/\D/g, '').trim();
      const nombreClean = String(body.nombre_completo || '').replace(/\s+/g, ' ').trim().toUpperCase();
      const telefonoClean = String(body.telefono || '').replace(/[^\d+\-\s()]/g, '').trim();
      const correoClean = String(body.correo_electronico || '').trim().toLowerCase();
      const pnfId = Number(body.pnf_id);
      const pnfNombre = PNF_CATALOG[pnfId];

      if (!cedulaClean || cedulaClean.length < 5 || cedulaClean.length > 11) {
        return res.status(400).json({ ok: false, message: 'Ingresa un número de cédula válido (solo números, entre 5 y 11 dígitos).' });
      }
      if (!nombreClean || nombreClean.length < 5) {
        return res.status(400).json({ ok: false, message: 'Ingresa tu nombre y apellido completos.' });
      }
      if (!telefonoClean || telefonoClean.replace(/\D/g, '').length < 10) {
        return res.status(400).json({ ok: false, message: 'Ingresa un número de teléfono válido (mínimo 10 dígitos).' });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!correoClean || !emailRegex.test(correoClean)) {
        return res.status(400).json({ ok: false, message: 'Ingresa un correo electrónico válido.' });
      }
      if (!pnfNombre) {
        return res.status(400).json({ ok: false, message: 'Selecciona el Programa de Formación (PNF / PT) al que perteneces.' });
      }

      // Asegurar tablas y verificar si ya existe la cédula
      const checkPipeline = await executeTursoPipeline([
        {
          type: 'execute',
          stmt: {
            sql: `CREATE TABLE IF NOT EXISTS participantes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              cedula TEXT NOT NULL UNIQUE,
              nombre_completo TEXT NOT NULL,
              telefono TEXT NOT NULL,
              correo_electronico TEXT NOT NULL,
              pnf_id INTEGER NOT NULL,
              pnf_nombre TEXT NOT NULL,
              fecha_registro TEXT DEFAULT (datetime('now', '-4 hours'))
            );`
          }
        },
        {
          type: 'execute',
          stmt: {
            sql: 'SELECT cedula, nombre_completo, telefono, correo_electronico, pnf_id, pnf_nombre, fecha_registro FROM participantes WHERE cedula = ? LIMIT 1;',
            args: [{ type: 'text', value: cedulaClean }]
          }
        }
      ]);

      const existingRows = checkPipeline?.results?.[1]?.response?.result?.rows || [];
      if (existingRows.length > 0) {
        const r = existingRows[0];
        return res.status(200).json({
          ok: true,
          alreadyRegistered: true,
          message: '¡Tus datos ya se encuentran registrados en el sistema para la emisión de tu certificado de participación!',
          participante: {
            cedula: r[0]?.value,
            nombre_completo: r[1]?.value,
            telefono: r[2]?.value,
            correo_electronico: r[3]?.value,
            pnf_id: Number(r[4]?.value),
            pnf_nombre: r[5]?.value,
            fecha_registro: r[6]?.value
          }
        });
      }

      // Insertar nuevo participante
      const insertPipeline = await executeTursoPipeline([
        {
          type: 'execute',
          stmt: {
            sql: `INSERT INTO participantes (cedula, nombre_completo, telefono, correo_electronico, pnf_id, pnf_nombre)
                  VALUES (?, ?, ?, ?, ?, ?);`,
            args: [
              { type: 'text', value: cedulaClean },
              { type: 'text', value: nombreClean },
              { type: 'text', value: telefonoClean },
              { type: 'text', value: correoClean },
              { type: 'integer', value: String(pnfId) },
              { type: 'text', value: pnfNombre }
            ]
          }
        }
      ]);

      const insertResult = insertPipeline?.results?.[0];
      if (insertResult?.type === 'error') {
        throw new Error(insertResult.error?.message || 'No se pudo guardar el registro.');
      }

      return res.status(201).json({
        ok: true,
        alreadyRegistered: false,
        message: '¡Tus datos fueron registrados exitosamente para la emisión de tu certificado de participación!',
        participante: {
          cedula: cedulaClean,
          nombre_completo: nombreClean,
          telefono: telefonoClean,
          correo_electronico: correoClean,
          pnf_id: pnfId,
          pnf_nombre: pnfNombre,
          fecha_registro: new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' })
        }
      });
    } catch (err) {
      return res.status(500).json({
        ok: false,
        message: 'Ocurrió un error procesando tu registro. Intenta nuevamente.',
        detail: err.message
      });
    }
  }

  return res.status(405).json({ ok: false, message: 'Método no permitido' });
};
