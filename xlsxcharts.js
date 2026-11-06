'use strict';
// Gráficos nativos de Excel (DrawingML). ExcelJS no los genera, así que se agregan al archivo ya creado:
// cada gráfico queda enlazado a las celdas de su tabla, se puede editar y se ve en Excel, Google Sheets y LibreOffice.

const zipLib = require('jszip');
const loadZip = async () => (typeof zipLib.load === 'function' ? zipLib.load() : zipLib);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const solid = (hex) => `<a:solidFill><a:srgbClr val="${hex}"/></a:solidFill>`;
const font = (sz, hex, bold = false) => `<a:defRPr sz="${sz}" b="${bold ? 1 : 0}">${solid(hex)}<a:latin typeface="Calibri"/></a:defRPr>`;
const txPr = (sz, hex, bold = false) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${font(sz, hex, bold)}</a:pPr><a:endParaRPr lang="es-CO"/></a:p></c:txPr>`;
const MONEY = '"$" #,##0';

function title(text) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>${font(1200, '0C2627', true)}</a:pPr><a:r><a:rPr lang="es-CO" sz="1200" b="1">${solid('0C2627')}<a:latin typeface="Calibri"/></a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`;
}
function strRef(ref, values) {
  return `<c:strRef><c:f>${esc(ref)}</c:f><c:strCache><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join('')}</c:strCache></c:strRef>`;
}
function numRef(ref, values) {
  return `<c:numRef><c:f>${esc(ref)}</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, i) => `<c:pt idx="${i}"><c:v>${Number(v) || 0}</c:v></c:pt>`).join('')}</c:numCache></c:numRef>`;
}
function dLbls({ fmt = MONEY, val = false, pct = false, color = '3C5254', size = 800, bold = false, pos = '' }) {
  return `<c:dLbls><c:numFmt formatCode="${esc(fmt)}" sourceLinked="0"/><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(size, color, bold)}${pos ? `<c:dLblPos val="${pos}"/>` : ''}<c:showLegendKey val="0"/><c:showVal val="${val ? 1 : 0}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="${pct ? 1 : 0}"/><c:showBubbleSize val="0"/><c:showLeaderLines val="0"/></c:dLbls>`;
}
const frame = (inner, legend = 'b') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace ${NS}><c:roundedCorners val="0"/><c:chart>${inner}${legend ? `<c:legend><c:legendPos val="${legend}"/><c:overlay val="0"/>${txPr(900, '3C5254')}</c:legend>` : ''}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr>${solid('FFFFFF')}<a:ln w="9525">${solid('DCE5E2')}</a:ln></c:spPr>${txPr(900, '3C5254')}</c:chartSpace>`;

function axes(horizontal, valFmt) {
  const cat = `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="${horizontal ? 'maxMin' : 'minMax'}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln w="9525">${solid('C9D4D0')}</a:ln></c:spPr>${txPr(900, '3C5254')}<c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const val = `<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/><c:majorGridlines><c:spPr><a:ln w="6350">${solid('E6ECEB')}</a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="${esc(valFmt)}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(800, '6A7D7E')}<c:crossAx val="5001"/><c:crosses val="${horizontal ? 'max' : 'autoZero'}"/><c:crossBetween val="between"/></c:valAx>`;
  return cat + val;
}

/** Barras (columnas verticales u horizontales), una o varias series; `pointColors` colorea cada barra. */
function barChart(ch) {
  const horizontal = ch.type === 'barH';
  const sers = ch.series.map((s, i) => `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>
    <c:spPr>${solid(s.color)}<a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/>
    ${(s.pointColors || []).map((col, k) => `<c:dPt><c:idx val="${k}"/><c:invertIfNegative val="0"/><c:bubble3D val="0"/><c:spPr>${solid(col)}</c:spPr></c:dPt>`).join('')}
    ${ch.labels ? dLbls({ fmt: ch.labelFmt || MONEY, val: true, pos: 'outEnd', color: '0C2627', bold: true }) : ''}
    <c:cat>${strRef(ch.catRef, ch.categories)}</c:cat><c:val>${numRef(s.ref, s.values)}</c:val></c:ser>`).join('');
  return frame(`${title(ch.title)}<c:plotArea><c:layout/><c:barChart><c:barDir val="${horizontal ? 'bar' : 'col'}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${sers}<c:gapWidth val="${ch.gap ?? 60}"/><c:overlap val="${ch.series.length > 1 ? -8 : 0}"/><c:axId val="5001"/><c:axId val="5002"/></c:barChart>${axes(horizontal, ch.valFmt || MONEY)}</c:plotArea>`, ch.series.length > 1 ? 'b' : '');
}

/** Dona con un color por porción y porcentajes. */
function doughnutChart(ch) {
  const s = ch.series[0];
  const pts = s.pointColors.map((col, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/><c:spPr>${solid(col)}<a:ln w="19050">${solid('FFFFFF')}</a:ln></c:spPr></c:dPt>`).join('');
  return frame(`${title(ch.title)}<c:plotArea><c:layout/><c:doughnutChart><c:varyColors val="1"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>${pts}
    ${dLbls({ fmt: '0%', pct: true, color: 'FFFFFF', size: 900, bold: true })}
    <c:cat>${strRef(ch.catRef, ch.categories)}</c:cat><c:val>${numRef(s.ref, s.values)}</c:val></c:ser><c:firstSliceAng val="0"/><c:holeSize val="${ch.hole || 55}"/></c:doughnutChart></c:plotArea>`, 'r');
}

function drawingXml(charts) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${charts.map((ch, i) => `
<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${ch.from.col}</xdr:col><xdr:colOff>${ch.from.colOff || 0}</xdr:colOff><xdr:row>${ch.from.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>${ch.to.col}</xdr:col><xdr:colOff>${ch.to.colOff || 0}</xdr:colOff><xdr:row>${ch.to.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="${esc(ch.title)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`).join('')}
</xdr:wsDr>`;
}

/**
 * charts: [{ sheet: n (1 = primera hoja), type: 'bar'|'barH'|'doughnut', title, from:{col,row}, to:{col,row} (base 0),
 *            catRef, categories, series: [{ name, ref, values, color?, pointColors? }] }]
 */
async function addCharts(buffer, charts, asUint8 = false) {
  if (!charts.length) return buffer;
  const JSZip = await loadZip();
  const zip = await JSZip.loadAsync(buffer);
  let types = await zip.file('[Content_Types].xml').async('string');
  const bySheet = new Map();
  charts.forEach((ch) => { if (!bySheet.has(ch.sheet)) bySheet.set(ch.sheet, []); bySheet.get(ch.sheet).push(ch); });
  let chartNo = 0;
  let drawingNo = 0;
  for (const [sheet, list] of bySheet) {
    drawingNo++;
    const relsChart = [];
    for (const ch of list) {
      chartNo++;
      zip.file(`xl/charts/chart${chartNo}.xml`, ch.type === 'doughnut' ? doughnutChart(ch) : barChart(ch));
      types = types.replace('</Types>', `<Override PartName="/xl/charts/chart${chartNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>`);
      relsChart.push(`<Relationship Id="rId${relsChart.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${chartNo}.xml"/>`);
    }
    zip.file(`xl/drawings/drawing${drawingNo}.xml`, drawingXml(list));
    zip.file(`xl/drawings/_rels/drawing${drawingNo}.xml.rels`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relsChart.join('')}</Relationships>`);
    types = types.replace('</Types>', `<Override PartName="/xl/drawings/drawing${drawingNo}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);

    const sheetPath = `xl/worksheets/sheet${sheet}.xml`;
    const relsPath = `xl/worksheets/_rels/sheet${sheet}.xml.rels`;
    const relId = 'rIdChartDrawing1';
    let rels = zip.file(relsPath) ? await zip.file(relsPath).async('string') : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    rels = rels.replace('</Relationships>', `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingNo}.xml"/></Relationships>`);
    zip.file(relsPath, rels);
    let xml = await zip.file(sheetPath).async('string');
    const tag = `<drawing r:id="${relId}"/>`;
    const at = ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<webPublishItems', '<tableParts', '<extLst', '</worksheet>']
      .map((t) => xml.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
    xml = xml.slice(0, at) + tag + xml.slice(at);
    zip.file(sheetPath, xml);
  }
  zip.file('[Content_Types].xml', types);
  return zip.generateAsync({ type: asUint8 ? 'uint8array' : 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { addCharts };
