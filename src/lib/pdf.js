import PDFDocument from 'pdfkit';
import { fmtMoney, fmtDate } from './cycles.js';

export function generateReceiptPDF({ payment, tenant, unit, property, settings = {} }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', margin: 36 });
    const chunks = [];

    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Colores
    const dark = '#1c1917';
    const muted = '#78716c';
    const accent = '#064e3b';

    // Header
    doc
      .fillColor(accent)
      .rect(36, 36, 50, 50)
      .fill();
    doc
      .fillColor('#fde68a')
      .font('Helvetica-Bold')
      .fontSize(16)
      .text('SAA', 36, 52, { width: 50, align: 'center' });

    doc
      .fillColor(dark)
      .font('Helvetica-Bold')
      .fontSize(14)
      .text('RECIBO DE PAGO', 100, 42);

    doc
      .fillColor(muted)
      .font('Helvetica')
      .fontSize(9)
      .text('Sistema Automatizado de Alquileres', 100, 60);

    doc
      .fillColor(dark)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(`N° ${String(payment.receipt_no).padStart(6, '0')}`, 100, 75);

    // Línea separadora
    doc
      .moveTo(36, 110)
      .lineTo(360, 110)
      .strokeColor('#e7e5e4')
      .lineWidth(1)
      .stroke();

    // Fecha de emisión
    doc
      .fillColor(muted)
      .font('Helvetica')
      .fontSize(8)
      .text('FECHA DE PAGO', 36, 125);
    doc
      .fillColor(dark)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(fmtDate(payment.paid_date), 36, 137);

    doc
      .fillColor(muted)
      .font('Helvetica')
      .fontSize(8)
      .text('MÉTODO', 220, 125);
    doc
      .fillColor(dark)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(payment.method || 'Efectivo', 220, 137);

    // Inquilino
    let y = 175;
    doc
      .fillColor(muted)
      .font('Helvetica')
      .fontSize(8)
      .text('RECIBIDO DE', 36, y);
    y += 12;
    doc
      .fillColor(dark)
      .font('Helvetica-Bold')
      .fontSize(13)
      .text(tenant.full_name, 36, y);
    y += 16;
    if (tenant.dni) {
      doc.fillColor(muted).font('Helvetica').fontSize(9).text(`DNI ${tenant.dni}`, 36, y);
      y += 12;
    }

    // Unidad
    if (unit) {
      y += 8;
      doc
        .fillColor(muted)
        .font('Helvetica')
        .fontSize(8)
        .text('UNIDAD', 36, y);
      y += 12;
      doc
        .fillColor(dark)
        .font('Helvetica')
        .fontSize(11)
        .text(`${unit.name}${property ? ` · ${property.name}` : ''}`, 36, y);
      y += 14;
      if (property?.address) {
        doc.fillColor(muted).fontSize(9).text(property.address, 36, y);
        y += 12;
      }
    }

    // Concepto
    y += 16;
    doc
      .strokeColor('#e7e5e4')
      .moveTo(36, y)
      .lineTo(360, y)
      .stroke();
    y += 12;

    doc
      .fillColor(muted)
      .font('Helvetica')
      .fontSize(8)
      .text('CONCEPTO', 36, y);
    y += 12;
    doc
      .fillColor(dark)
      .font('Helvetica')
      .fontSize(10)
      .text(`Alquiler — período del ${fmtDate(payment.period_start)} al ${fmtDate(payment.period_end)}`, 36, y, {
        width: 324,
      });

    y += 32;

    // Monto destacado
    doc
      .fillColor(accent)
      .rect(36, y, 324, 40)
      .fill();
    doc
      .fillColor('#fde68a')
      .font('Helvetica')
      .fontSize(8)
      .text('MONTO PAGADO', 48, y + 8);
    doc
      .fillColor('#fff')
      .font('Helvetica-Bold')
      .fontSize(20)
      .text(fmtMoney(payment.amount), 48, y + 18);

    y += 60;

    // Notas
    if (payment.notes) {
      doc
        .fillColor(muted)
        .font('Helvetica')
        .fontSize(8)
        .text('OBSERVACIONES', 36, y);
      y += 10;
      doc
        .fillColor(dark)
        .fontSize(9)
        .text(payment.notes, 36, y, { width: 324 });
    }

    // Footer
    doc
      .fillColor(muted)
      .font('Helvetica')
      .fontSize(7)
      .text(
        `Documento generado por ${settings.appName || 'SAA'} el ${fmtDate(
          new Date().toISOString().slice(0, 10)
        )} · No tiene validez tributaria`,
        36,
        540,
        { width: 324, align: 'center' }
      );

    doc.end();
  });
}
