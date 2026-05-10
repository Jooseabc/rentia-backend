import PDFDocument from 'pdfkit';
import { fmtMoney, fmtDate } from './cycles.js';

const MONTH_NAMES_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

// Estado de cuenta de un inquilino: lista todos los ciclos con su estado
// (pagado / pendiente / en mora) y arroja totales acumulados.
export function generateTenantStatementPDF({ tenant, unit, property, items, totals }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dark = '#1c1917';
    const muted = '#78716c';
    const accent = '#064e3b';

    // Header
    doc.fillColor(accent).rect(48, 48, 50, 50).fill();
    doc.fillColor('#fde68a').font('Helvetica-Bold').fontSize(16)
       .text('SAA', 48, 64, { width: 50, align: 'center' });

    doc.fillColor(dark).font('Helvetica-Bold').fontSize(18)
       .text('Estado de cuenta', 112, 54);
    doc.fillColor(muted).font('Helvetica').fontSize(10)
       .text(`Generado el ${fmtDate(new Date().toISOString().slice(0, 10))}`, 112, 76);

    doc.moveTo(48, 120).lineTo(547, 120).strokeColor('#e7e5e4').lineWidth(1).stroke();

    // Datos del inquilino
    let y = 138;
    doc.fillColor(muted).font('Helvetica').fontSize(8).text('INQUILINO', 48, y);
    doc.fillColor(dark).font('Helvetica-Bold').fontSize(13).text(tenant.full_name, 48, y + 12);
    if (tenant.dni) {
      doc.fillColor(muted).font('Helvetica').fontSize(9).text(`DNI ${tenant.dni}`, 48, y + 30);
    }

    if (unit) {
      doc.fillColor(muted).font('Helvetica').fontSize(8).text('UNIDAD', 320, y);
      doc.fillColor(dark).font('Helvetica').fontSize(11)
         .text(`${unit.name}${property ? ` · ${property.name}` : ''}`, 320, y + 12);
      if (property?.address) {
        doc.fillColor(muted).fontSize(9).text(property.address, 320, y + 28);
      }
    }
    y += 60;

    // Totales
    doc.fillColor(muted).font('Helvetica').fontSize(8).text('TOTAL PAGADO', 48, y);
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(18).text(fmtMoney(totals.paid), 48, y + 12);

    doc.fillColor(muted).font('Helvetica').fontSize(8).text('SALDO PENDIENTE', 320, y);
    doc.fillColor(totals.pending > 0 ? '#991b1b' : dark).font('Helvetica-Bold').fontSize(18)
       .text(fmtMoney(totals.pending), 320, y + 12);

    y += 50;
    doc.fillColor(muted).font('Helvetica').fontSize(8)
       .text(`${totals.paid_count} ciclo(s) pagado(s) · ${totals.overdue_count} en mora · ${totals.pending_count} corriente`, 48, y);
    y += 24;

    // Tabla de ciclos
    function ensureSpace(yPos, needed = 40) {
      if (yPos + needed > 780) {
        doc.addPage();
        return 60;
      }
      return yPos;
    }

    function row(cells, yPos, opts = {}) {
      const widths = [90, 90, 100, 100, 119];
      const aligns = ['left', 'left', 'left', 'right', 'left'];
      let x = 48;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9)
         .fillColor(opts.bold ? muted : dark);
      cells.forEach((c, i) => {
        doc.text(String(c ?? ''), x + 4, yPos + 4, { width: widths[i] - 8, align: aligns[i] });
        x += widths[i];
      });
      doc.moveTo(48, yPos + 18).lineTo(547, yPos + 18).strokeColor('#f5f5f4').stroke();
      return yPos + 18;
    }

    doc.fillColor(dark).font('Helvetica-Bold').fontSize(12).text('Detalle por ciclo', 48, y);
    y += 24;
    y = row(['CICLO INICIA', 'CICLO TERMINA', 'PAGADO EL', 'MONTO', 'ESTADO'], y, { bold: true });

    for (const it of items) {
      y = ensureSpace(y, 22);
      const stateLabel = it.kind === 'paid' ? 'Pagado' : it.kind === 'overdue' ? 'En mora' : 'Corriente';
      y = row(
        [
          fmtDate(it.cycle.start),
          fmtDate(it.cycle.end),
          it.payment ? fmtDate(it.payment.paid_date) : '—',
          fmtMoney(it.amount),
          stateLabel,
        ],
        y
      );
    }

    // Footer
    doc.fillColor(muted).font('Helvetica').fontSize(7)
       .text(
         `Documento informativo · Sistema Automatizado de Alquileres · No tiene validez tributaria`,
         48, 800, { width: 499, align: 'center' }
       );

    doc.end();
  });
}

export function generateMonthlySummaryPDF({ month, from, to, collected, pending }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const dark = '#1c1917';
    const muted = '#78716c';
    const accent = '#064e3b';

    const [y, m] = month.split('-').map(Number);
    const monthLabel = `${MONTH_NAMES_ES[m - 1]} ${y}`;

    const totalCollected = collected.reduce((s, p) => s + Number(p.amount || 0), 0);
    const totalPending = pending.reduce((s, p) => s + Number(p.amount || 0), 0);

    // Header
    doc.fillColor(accent).rect(48, 48, 50, 50).fill();
    doc.fillColor('#fde68a').font('Helvetica-Bold').fontSize(16)
       .text('SAA', 48, 64, { width: 50, align: 'center' });

    doc.fillColor(dark).font('Helvetica-Bold').fontSize(18)
       .text('Resumen mensual', 112, 54);
    doc.fillColor(muted).font('Helvetica').fontSize(10)
       .text(`Período: ${fmtDate(from)} — ${fmtDate(to)}`, 112, 76);
    doc.fillColor(dark).font('Helvetica-Bold').fontSize(12)
       .text(monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1), 112, 92);

    doc.moveTo(48, 120).lineTo(547, 120).strokeColor('#e7e5e4').lineWidth(1).stroke();

    // Totales
    let y0 = 138;
    doc.fillColor(muted).font('Helvetica').fontSize(9).text('COBRADO EN EL MES', 48, y0);
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(20)
       .text(fmtMoney(totalCollected), 48, y0 + 14);

    doc.fillColor(muted).font('Helvetica').fontSize(9).text('PENDIENTE / EN MORA', 320, y0);
    doc.fillColor(pending.length ? '#991b1b' : dark).font('Helvetica-Bold').fontSize(20)
       .text(fmtMoney(totalPending), 320, y0 + 14);

    y0 += 56;
    doc.fillColor(muted).font('Helvetica').fontSize(8)
       .text(`${collected.length} pago(s) cobrado(s) · ${pending.length} pendiente(s)`, 48, y0);

    y0 += 24;

    // Sección: Pagos cobrados
    function sectionTitle(label, yPos) {
      doc.fillColor(dark).font('Helvetica-Bold').fontSize(12).text(label, 48, yPos);
      doc.moveTo(48, yPos + 18).lineTo(547, yPos + 18).strokeColor('#e7e5e4').stroke();
      return yPos + 26;
    }

    function tableRow(cells, yPos, opts = {}) {
      const widths = opts.widths;
      let x = 48;
      doc.font(opts.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.bold ? 9 : 9)
         .fillColor(opts.bold ? muted : dark);
      cells.forEach((c, i) => {
        const align = opts.aligns?.[i] || 'left';
        doc.text(String(c ?? ''), x + 4, yPos + 4, { width: widths[i] - 8, align });
        x += widths[i];
      });
      if (!opts.bold) {
        doc.moveTo(48, yPos + 18).lineTo(547, yPos + 18).strokeColor('#f5f5f4').stroke();
      }
      return yPos + 18;
    }

    function ensureSpace(yPos, needed = 100) {
      if (yPos + needed > 780) {
        doc.addPage();
        return 60;
      }
      return yPos;
    }

    if (collected.length) {
      y0 = ensureSpace(y0, 60);
      y0 = sectionTitle('Pagos cobrados', y0);
      const widths = [70, 200, 150, 79];
      const aligns = ['left', 'left', 'left', 'right'];
      y0 = tableRow(['FECHA', 'INQUILINO', 'UNIDAD', 'MONTO'], y0, { widths, aligns, bold: true });
      for (const p of collected) {
        y0 = ensureSpace(y0, 30);
        y0 = tableRow(
          [
            fmtDate(p.paid_date),
            p.tenant_name,
            [p.unit_name, p.property_name].filter(Boolean).join(' · '),
            fmtMoney(p.amount),
          ],
          y0,
          { widths, aligns }
        );
      }
      y0 += 8;
    }

    if (pending.length) {
      y0 = ensureSpace(y0, 60);
      y0 = sectionTitle('Pendientes / en mora', y0);
      const widths = [80, 220, 140, 59];
      const aligns = ['left', 'left', 'left', 'right'];
      y0 = tableRow(['CICLO INICIA', 'INQUILINO', 'UNIDAD', 'MONTO'], y0, { widths, aligns, bold: true });
      for (const p of pending) {
        y0 = ensureSpace(y0, 30);
        y0 = tableRow(
          [
            fmtDate(p.cycle_start),
            p.tenant_name,
            [p.unit_name, p.property_name].filter(Boolean).join(' · '),
            fmtMoney(p.amount),
          ],
          y0,
          { widths, aligns }
        );
      }
    }

    // Footer
    doc.fillColor(muted).font('Helvetica').fontSize(7)
       .text(
         `Generado el ${fmtDate(new Date().toISOString().slice(0, 10))} · Sistema Automatizado de Alquileres`,
         48, 800, { width: 499, align: 'center' }
       );

    doc.end();
  });
}

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
