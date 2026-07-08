/**
 * CRM Colegios - Script de escritura para Google Sheets
 *
 * INSTRUCCIONES:
 * 1. Abre la hoja de calculo -> Extensiones -> Apps Script
 * 2. Reemplaza TODO el codigo por este archivo
 * 3. Implementar -> Nueva implementacion -> Aplicacion web
 * 4. Ejecutar como: Yo | Acceso: Cualquier persona
 * 5. Copia la URL y pegala en scriptUrl dentro de index.html si cambia
 */

var SHEET_ID = "1RCNyiHto-QRJjrdiDO3trl-MajouzlcCLnc1hMW0EIU";

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var tipo = String(payload.tipo || "").toLowerCase();
    var fila = Number(payload.fila);
    var valores = payload.valores || [];

    if (!isFinite(fila) || fila < 0) {
      return response({ success: false, error: "Indice de fila invalido" });
    }
    if (!valores.length) {
      return response({ success: false, error: "No llegaron valores para guardar" });
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var row = fila + 2; // fila 0 = fila 2 en la hoja

    if (tipo === "datos") {
      var hojaDatos = ss.getSheetByName("Datos");
      if (!hojaDatos) {
        return response({ success: false, error: 'No existe la hoja "Datos"' });
      }
      hojaDatos.getRange(row, 1, 1, valores.length).setValues([valores]);
      return response({ success: true, hoja: "Datos", fila: row });

    }

    if (tipo === "senso") {
      var hojaSenso = ss.getSheetByName("SENSO");
      if (!hojaSenso) {
        return response({ success: false, error: 'No existe la hoja "SENSO"' });
      }
      // El censo se guarda desde la columna B (nombre del colegio)
      hojaSenso.getRange(row, 2, 1, valores.length).setValues([valores]);
      return response({ success: true, hoja: "SENSO", fila: row });
    }

    return response({ success: false, error: "Tipo no reconocido: " + payload.tipo });
  } catch (err) {
    return response({ success: false, error: err.message });
  }
}

function response(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}