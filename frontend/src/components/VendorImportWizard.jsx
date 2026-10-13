import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { importVendors } from '../api/client.js';
import { Button, InlineAlert, StatusBadge } from './ui.jsx';

const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPTED_LABEL = 'Excel (.xlsx, .xls) or CSV · Up to 10 MB · Parsed in your browser';

export const FIELD_DEFS = [
  { key: 'vendorName', label: 'Vendor name', required: true, group: 'Supplier identity' },
  { key: 'vendorId', label: 'Vendor ID', required: true, group: 'Supplier identity' },
  { key: 'productId', label: 'Product / SKU', required: true, group: 'Offer identity' },
  { key: 'currency', label: 'Currency (e.g. INR)', required: true, group: 'Pricing' },
  { key: 'unitPrice', label: 'Unit price', required: true, group: 'Pricing', money: true, hint: 'Major units (125.50) unless the column header contains “minor”.' },
  { key: 'quantity', label: 'Available quantity', required: true, group: 'Availability' },
  { key: 'deliveryDays', label: 'Delivery days', required: true, group: 'Availability' },
  { key: 'shipping', label: 'Shipping charge', required: true, group: 'Pricing', money: true },
  { key: 'tax', label: 'Tax charge', required: true, group: 'Pricing', money: true },
  { key: 'fees', label: 'Other fees', required: true, group: 'Pricing', money: true },
  { key: 'approved', label: 'Approved status', required: true, group: 'Controls' },
  { key: 'quality', label: 'Quality score (0–100)', required: true, group: 'Controls' },
  { key: 'reliability', label: 'Reliability score (0–100)', required: true, group: 'Controls' },
  { key: 'email', label: 'Contact email', required: false, group: 'Optional' },
  { key: 'website', label: 'Website', required: false, group: 'Optional' },
];

const SUPPORTED_CURRENCIES = ['INR','USD','EUR','GBP','AUD','CAD','CHF','CNY','SGD','NZD','HKD','AED','SAR','BRL','MXN','ZAR','JPY','KRW','VND','CLP','BHD','KWD','OMR','JOD','TND'];

const APPROVED_TRUE = new Set(['true','yes','y','approved','active','1']);
const APPROVED_FALSE = new Set(['false','no','n','unapproved','inactive','0','rejected']);
const APPROVED_ALL = new Set([...APPROVED_TRUE, ...APPROVED_FALSE]);

const ALIASES = {
  vendorName: ['vendorname','suppliername','vendor','supplier'],
  vendorId: ['vendorid','supplierid','suppliercode'],
  productId: ['productid','sku','productcode'],
  currency: ['currency'],
  unitPrice: ['unitpriceminor','unitprice','price','unitcost','cost'],
  quantity: ['availablequantity','stock','quantity'],
  shipping: ['shippingminor','shipping','freight'],
  tax: ['taxminor','tax'],
  fees: ['feesminor','fees','handlingfee'],
  deliveryDays: ['deliverydays','leadtime','delivery'],
  approved: ['vendorapproved','approvedvendor','approved','status'],
  quality: ['qualityscore','quality'],
  reliability: ['reliabilityscore','reliability'],
  email: ['contactemail','email'],
  website: ['website','url'],
};

function autoMap(headers) {
  const out = {};
  for (const [field, words] of Object.entries(ALIASES)) {
    out[field] = headers.find((h) => words.some((w) => h.toLowerCase().replace(/[^a-z]/g, '').includes(w))) || '';
  }
  return out;
}

function isMinorHeader(headerName) {
  return String(headerName || '').toLowerCase().includes('minor');
}

function parseMoneyCell(raw, headerName) {
  const text = String(raw ?? '').trim();
  if (text === '') return { empty: true, value: NaN, minor: false };
  const minor = isMinorHeader(headerName);
  if (minor) {
    const n = Number(text.replace(/[,\s]/g, ''));
    if (!Number.isFinite(n)) return { empty: false, value: NaN, minor: true, invalid: true };
    return { empty: false, value: n, minor: true, invalid: !Number.isInteger(n) || n < 0 };
  }
  const cleaned = text.replace(/[₹$€£,\s]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return { empty: false, value: NaN, minor: false, invalid: true };
  if (n < 0) return { empty: false, value: n, minor: false, invalid: true };
  return { empty: false, value: n, minor: false, invalid: false, minorValue: Math.round(n * 100) };
}

function validateRow(r) {
  const issues = [];
  if (!r.vendorName) issues.push('Missing vendor name.');
  if (!r.vendorId) issues.push('Missing vendor ID.');
  if (!r.productId) issues.push('Missing product / SKU.');
  if (!r.offerId) issues.push('Cannot build offer ID from vendor ID + product.');
  if (!/^[A-Z]{3}$/.test(r.currency)) issues.push(`Currency “${r.currency || '—'}” must be a 3-letter code (e.g. INR).`);
  else if (!SUPPORTED_CURRENCIES.includes(r.currency)) issues.push(`Currency ${r.currency} is not supported by the evaluation engine.`);
  if (r.unitPriceEmpty) issues.push('Unit price is missing. Charges must be explicit — blank is not zero.');
  else if (r.unitPriceInvalid) issues.push(`Unit price “${r.unitPriceRaw}” is not a valid non-negative amount.`);
  if (r.quantityEmpty) issues.push('Available quantity is missing.');
  else if (!Number.isInteger(r.quantity) || r.quantity < 0) issues.push('Available quantity must be a whole number ≥ 0.');
  if (r.deliveryEmpty) issues.push('Delivery days is missing.');
  else if (!Number.isInteger(r.deliveryDays) || r.deliveryDays < 0) issues.push('Delivery days must be a whole number ≥ 0.');
  for (const [key, label] of [['shipping','Shipping'],['tax','Tax'],['fees','Fees']]) {
    if (r[`${key}Empty`]) issues.push(`${label} charge is missing. Enter 0 explicitly if there is no charge.`);
    else if (r[`${key}Invalid`]) issues.push(`${label} charge “${r[`${key}Raw`]}” is not valid.`);
  }
  if (r.qualityEmpty) issues.push('Quality score is missing.');
  else if (!Number.isFinite(r.quality) || r.quality < 0 || r.quality > 100) issues.push('Quality score must be 0–100.');
  if (r.reliabilityEmpty) issues.push('Reliability score is missing.');
  else if (!Number.isFinite(r.reliability) || r.reliability < 0 || r.reliability > 100) issues.push('Reliability score must be 0–100.');
  if (!r.approvedRaw) issues.push('Approval status is missing.');
  else if (!APPROVED_ALL.has(r.approvedRaw)) issues.push(`Approval status “${r.approvedRaw}” is not recognised (use approved / rejected, yes / no, true / false, active / inactive).`);
  return issues;
}

export default function VendorImportWizard({ onImported, onStateChange, showHeader = true }) {
  const [stage, setStage] = useState(0); // 0 upload, 1 map, 2 review, 3 confirm, 4 results
  const [fileInfo, setFileInfo] = useState(null);
  const [sheetNames, setSheetNames] = useState([]);
  const [sheetName, setSheetName] = useState('');
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [fileError, setFileError] = useState('');
  const [parsing, setParsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importError, setImportError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const fileInputRef = useRef(null);

  const STAGES = ['Upload', 'Map columns', 'Review data', 'Import', 'Results'];

  function notify(patch) {
    if (onStateChange) {
      try { onStateChange(patch); } catch { /* ignore */ }
    }
  }

  function parseSheet(workbook, name, fileName) {
    const ws = workbook.Sheets[name];
    const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const hs = (data[0] || []).map((h, i) => String(h || `Column ${i + 1}`).trim());
    const body = data
      .slice(1)
      .filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
      .map((row, i) => ({ __row: i + 2, values: hs.map((_, j) => row[j] ?? '') }));
    setSheetName(name);
    setHeaders(hs);
    setRows(body);
    const m = autoMap(hs);
    setMapping(m);
    notify({ headers: hs, rows: body, rowsRead: body.length, mapping: m, sheetName: name, fileName: fileName || fileInfo?.name || null });
  }

  async function handleFile(file) {
    setFileError('');
    setImportError('');
    setImportResult(null);
    setFileInfo(null);
    setHeaders([]);
    setRows([]);
    setSheetNames([]);
    setMapping({});
    if (!file) return;
    if (!/\.(xlsx|xls|csv)$/i.test(file.name)) {
      setFileError('Unsupported format. Choose an .xlsx, .xls, or .csv file.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setFileError('The file exceeds the 10 MB limit. Split the spreadsheet and try again.');
      return;
    }
    setParsing(true);
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      if (!wb.SheetNames.length) throw new Error('No worksheets were found in this file.');
      setFileInfo({ name: file.name, size: file.size, workbook: wb });
      setSheetNames(wb.SheetNames);
      parseSheet(wb, wb.SheetNames[0], file.name);
      notify({ fileName: file.name, rowsRead: 0, sheetName: wb.SheetNames[0] });
      setStage(1);
    } catch (e) {
      setFileError(e.message || 'Could not read this spreadsheet. Check that the file is not corrupt.');
    } finally {
      setParsing(false);
    }
  }

  const mappedRows = useMemo(() => rows.map((row) => {
    const cell = (key) => {
      const h = mapping[key];
      if (!h) return '';
      const idx = headers.indexOf(h);
      return idx < 0 ? '' : row.values[idx] ?? '';
    };
    const num = (key) => {
      const t = String(cell(key) ?? '').trim().replace(/[₹$€£,\s]/g, '');
      if (t === '') return NaN;
      return Number(t);
    };
    const approvedRaw = String(cell('approved')).trim().toLowerCase();
    const approved = APPROVED_TRUE.has(approvedRaw);
    const vendorId = String(cell('vendorId')).trim();
    const productId = String(cell('productId')).trim();
    const currency = String(cell('currency')).trim().toUpperCase();

    const unitP = parseMoneyCell(cell('unitPrice'), mapping.unitPrice);
    const shipP = parseMoneyCell(cell('shipping'), mapping.shipping);
    const taxP = parseMoneyCell(cell('tax'), mapping.tax);
    const feesP = parseMoneyCell(cell('fees'), mapping.fees);

    const qRaw = String(cell('quantity') ?? '').trim();
    const dRaw = String(cell('deliveryDays') ?? '').trim();
    const qEmpty = qRaw === '';
    const dEmpty = dRaw === '';
    const qNum = qEmpty ? NaN : Number(qRaw.replace(/[,\s]/g, ''));
    const dNum = dEmpty ? NaN : Number(dRaw.replace(/[,\s]/g, ''));

    const qualRaw = String(cell('quality') ?? '').trim();
    const relRaw = String(cell('reliability') ?? '').trim();

    const r = {
      row: row.__row,
      vendorName: String(cell('vendorName')).trim(),
      vendorId,
      productId,
      currency,
      unitPriceRaw: String(cell('unitPrice') ?? ''),
      unitPriceEmpty: unitP.empty,
      unitPriceInvalid: unitP.invalid,
      unitPriceMajor: unitP.minor ? unitP.value / 100 : unitP.value,
      unitPriceMinor: unitP.minor ? unitP.value : unitP.minorValue,
      unitPriceIsMinor: unitP.minor,
      quantity: qNum,
      quantityEmpty: qEmpty,
      deliveryDays: dNum,
      deliveryEmpty: dEmpty,
      shippingRaw: String(cell('shipping') ?? ''),
      shippingEmpty: shipP.empty,
      shippingInvalid: shipP.invalid,
      shippingMinor: shipP.minor ? shipP.value : shipP.minorValue,
      taxRaw: String(cell('tax') ?? ''),
      taxEmpty: taxP.empty,
      taxInvalid: taxP.invalid,
      taxMinor: taxP.minor ? taxP.value : taxP.minorValue,
      feesRaw: String(cell('fees') ?? ''),
      feesEmpty: feesP.empty,
      feesInvalid: feesP.invalid,
      feesMinor: feesP.minor ? feesP.value : feesP.minorValue,
      approved,
      approvedRaw,
      quality: qualRaw === '' ? NaN : Number(qualRaw),
      qualityEmpty: qualRaw === '',
      reliability: relRaw === '' ? NaN : Number(relRaw),
      reliabilityEmpty: relRaw === '',
      email: String(cell('email')).trim(),
      website: String(cell('website')).trim(),
      offerId: vendorId && productId ? `${vendorId}-${productId}`.replace(/[^a-zA-Z0-9_-]/g, '-') : '',
    };
    r.issues = validateRow(r);
    r.valid = r.issues.length === 0;
    return r;
  }), [rows, headers, mapping]);

  const requiredFields = FIELD_DEFS.filter((f) => f.required).map((f) => f.key);
  const missingFields = requiredFields.filter((k) => !mapping[k]);
  const invalidRows = mappedRows.filter((r) => !r.valid);
  const validRows = mappedRows.filter((r) => r.valid);
  const duplicateIds = useMemo(() => {
    const seen = new Map();
    const dupes = new Set();
    for (const r of mappedRows) {
      if (!r.offerId) continue;
      if (seen.has(r.offerId)) { dupes.add(r.offerId); }
      else seen.set(r.offerId, r.row);
    }
    return dupes;
  }, [mappedRows]);
  const duplicateCount = mappedRows.filter((r) => r.offerId && duplicateIds.has(r.offerId)).length;

  const canReview = fileInfo && rows.length > 0;
  const canConfirm = canReview && missingFields.length === 0 && invalidRows.length === 0 && duplicateCount === 0 && validRows.length > 0;

  async function doImport() {
    setImportError('');
    setImportResult(null);
    if (!fileInfo) { setFileError('Choose a spreadsheet before importing.'); setStage(0); return; }
    if (missingFields.length) { setFileError(`Map all required fields before importing: ${missingFields.join(', ')}.`); setStage(1); return; }
    if (invalidRows.length || duplicateCount) { setFileError('Resolve invalid rows and duplicate offer IDs before importing.'); setStage(2); return; }
    setImporting(true);
    setConfirmOpen(false);
    try {
      const offers = validRows.map((r) => ({
        offerId: r.offerId,
        vendorId: r.vendorId,
        vendorName: r.vendorName,
        productId: r.productId,
        currency: r.currency,
        unitPriceMinor: r.unitPriceMinor,
        availableQuantity: r.quantity,
        deliveryDays: r.deliveryDays,
        shippingMinor: r.shippingMinor,
        taxMinor: r.taxMinor,
        feesMinor: r.feesMinor,
        vendorApproved: r.approved,
        qualityScore: r.quality,
        reliabilityScore: r.reliability,
        active: true,
      }));
      const result = await importVendors(offers);
      setImportResult(result);
      setStage(4);
      notify({ importResult: result, offers });
      if (onImported) onImported(result, offers, { fileName: fileInfo.name, sheetName, rowsRead: rows.length });
    } catch (err) {
      setImportError(err.message || 'Vendor import failed. Your file and column mapping have been preserved — correct the issue and retry.');
      setStage(3);
    } finally {
      setImporting(false);
    }
  }

  function resetAll() {
    setFileInfo(null); setSheetNames([]); setSheetName(''); setHeaders([]); setRows([]); setMapping({});
    setFileError(''); setImportError(''); setImportResult(null); setStage(0);
  }

  return (
    <div className="import-wizard">
      {showHeader ? (
        <div className="wizard-steps-indicator" role="list" aria-label="Import progress">
          {STAGES.map((label, i) => (
            <div key={label} role="listitem" aria-current={i === stage ? 'step' : undefined} className={i === stage ? 'wizard-pill active' : i < stage ? 'wizard-pill complete' : 'wizard-pill'}>
              <span className="wizard-pill-num">{i < stage ? '✓' : String(i + 1)}</span>
              <span className="wizard-pill-label">{label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Stage 0 — Upload */}
      {(stage === 0 || !fileInfo) && stage !== 4 ? (
        <section aria-label="Upload spreadsheet">
          <div
            className={dragging ? 'dropzone dragging' : 'dropzone'}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); handleFile(e.dataTransfer.files?.[0]); }}
          >
            <div className="dropzone-icon" aria-hidden="true">▤</div>
            <b>{parsing ? 'Reading spreadsheet…' : 'Drop a supplier spreadsheet here.'}</b>
            <p>Or browse files from your device. The file is parsed in your browser before anything is sent to the server.</p>
            <label className="button button-secondary file-button">
              Browse files
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => handleFile(e.target.files?.[0])} />
            </label>
            <small>{ACCEPTED_LABEL}</small>
            {parsing ? <div className="progress-bar" role="status" aria-label="Reading spreadsheet"><span /></div> : null}
          </div>
          {fileError ? <div className="form-error" role="alert">{fileError}</div> : null}
          {fileInfo ? (
            <div className="file-card">
              <span className="file-ext" aria-hidden="true">XLS</span>
              <span className="file-meta"><b>{fileInfo.name}</b><small>{(fileInfo.size / 1024).toFixed(1)} KB · {rows.length} data rows · {sheetNames.length} worksheet{sheetNames.length === 1 ? '' : 's'}</small></span>
              <button type="button" className="text-button" onClick={resetAll}>Remove</button>
            </div>
          ) : null}
          {fileInfo && canReview ? (
            <div className="wizard-footer">
              <span />
              <Button onClick={() => setStage(1)}>Continue to column mapping <span aria-hidden="true">→</span></Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Stage 1 — Map */}
      {fileInfo && stage === 1 ? (
        <section aria-label="Map columns">
          <div className="file-card">
            <span className="file-ext" aria-hidden="true">XLS</span>
            <span className="file-meta"><b>{fileInfo.name}</b><small>{(fileInfo.size / 1024).toFixed(1)} KB · {rows.length} data rows detected</small></span>
            <button type="button" className="text-button" onClick={resetAll}>Replace file</button>
          </div>
          {sheetNames.length > 1 ? (
            <label className="field field-inline">
              <span className="field-label">Worksheet ({sheetNames.length} found)</span>
              <select value={sheetName} onChange={(e) => parseSheet(fileInfo.workbook, e.target.value)}>
                {sheetNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
          ) : null}
          <div className="mapping-head">
            <div><h3>Map your columns</h3><p>{headers.length} columns detected. Required fields are marked. Choose “Not mapped” to leave an optional field empty.</p></div>
            <StatusBadge tone={missingFields.length ? 'warn' : 'ok'}>{missingFields.length ? `${missingFields.length} required unmapped` : 'All required fields mapped'}</StatusBadge>
          </div>
          <p className="mapping-help">Monetary spreadsheet values are interpreted as <b>major currency units</b> and converted once to minor units (for example, 125.50 → 12550 paise) — <b>unless</b> the mapped column header contains “minor” (e.g. <code>unitPriceMinor</code>), in which case the value is sent unchanged. Charges must be explicit: leave nothing blank to mean zero — enter <code>0</code>.</p>
          <div className="mapping-grid">
            {FIELD_DEFS.map((f) => (
              <label key={f.key} className="field">
                <span className="field-label">{f.label} {f.required ? <span className="required-mark">· Required</span> : <span className="optional-mark">· Optional</span>}</span>
                <select value={mapping[f.key] || ''} onChange={(e) => { const v = e.target.value; setMapping((m) => ({ ...m, [f.key]: v })); }}>
                  <option value="">Not mapped</option>
                  {headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select>
                {f.money && mapping[f.key] ? <small className="field-hint">{isMinorHeader(mapping[f.key]) ? 'Detected minor-unit column — values sent unchanged.' : 'Detected major-unit column — values × 100 on import.'}</small> : null}
              </label>
            ))}
          </div>
          {missingFields.length ? <InlineAlert tone="warn" title="Required fields still unmapped">{missingFields.join(', ')}</InlineAlert> : null}
          {fileError ? <div className="form-error" role="alert">{fileError}</div> : null}
          <div className="wizard-footer">
            <Button variant="secondary" onClick={() => setStage(0)}>← Back to upload</Button>
            <Button onClick={() => setStage(2)} disabled={!canReview || missingFields.length > 0}>Continue to review <span aria-hidden="true">→</span></Button>
          </div>
        </section>
      ) : null}

      {/* Stage 2 — Review */}
      {fileInfo && stage === 2 ? (
        <section aria-label="Review data">
          <div className="stat-grid">
            <div className="stat"><span>Total rows</span><b>{mappedRows.length}</b></div>
            <div className="stat"><span>Valid rows</span><b className="stat-good">{validRows.length}</b></div>
            <div className="stat"><span>Invalid rows</span><b className={invalidRows.length ? 'stat-bad' : ''}>{invalidRows.length}</b></div>
            <div className="stat"><span>Duplicate offer IDs</span><b className={duplicateCount ? 'stat-bad' : ''}>{duplicateCount}</b></div>
          </div>
          {duplicateCount ? <InlineAlert tone="error" title="Duplicate supplier / product combinations">Offer IDs must be unique. The upsert key is <code>offerId</code> (vendor ID + product). Duplicates in this file: {[...duplicateIds].join(', ')}</InlineAlert> : null}
          <div className="table-scroll" tabIndex={0} aria-label="Scrollable import preview">
            <table className="data-table preview-table">
              <thead><tr><th scope="col">Row</th><th scope="col">Status</th><th scope="col">Vendor</th><th scope="col">Offer ID</th><th scope="col">Currency</th><th scope="col">Unit price</th><th scope="col">Qty</th><th scope="col">Delivery</th><th scope="col">Approval</th><th scope="col">Issues</th></tr></thead>
              <tbody>
                {mappedRows.slice(0, 100).map((r) => (
                  <tr key={r.row} className={r.valid && !(r.offerId && duplicateIds.has(r.offerId)) ? '' : 'row-invalid'}>
                    <td className="num">{r.row}</td>
                    <td>{r.valid && !(r.offerId && duplicateIds.has(r.offerId)) ? <StatusBadge tone="ok">Valid</StatusBadge> : <StatusBadge tone="error">Invalid</StatusBadge>}</td>
                    <td>{r.vendorName || <span className="muted">—</span>}<small className="cell-sub">{r.vendorId}</small></td>
                    <td><code>{r.offerId || '—'}</code></td>
                    <td>{r.currency || '—'}</td>
                    <td className="num">{r.unitPriceEmpty ? '—' : r.unitPriceIsMinor ? `${r.unitPriceMinor}` : `${r.unitPriceMajor}`} {r.unitPriceIsMinor ? <small className="cell-sub">minor</small> : null}</td>
                    <td className="num">{Number.isFinite(r.quantity) ? r.quantity : '—'}</td>
                    <td className="num">{Number.isFinite(r.deliveryDays) ? `${r.deliveryDays}d` : '—'}</td>
                    <td>{r.approvedRaw || '—'}</td>
                    <td className="issues-cell">{r.issues.length ? r.issues.map((m, i) => <small key={i} className="issue">{m}</small>) : <small className="muted">—</small>}{r.offerId && duplicateIds.has(r.offerId) ? <small className="issue">Duplicate offer ID “{r.offerId}”.</small> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {mappedRows.length > 100 ? <p className="muted-note">Showing the first 100 of {mappedRows.length} rows. All rows are validated before import.</p> : null}
          {fileError ? <div className="form-error" role="alert">{fileError}</div> : null}
          <div className="wizard-footer">
            <Button variant="secondary" onClick={() => setStage(1)}>← Back to mapping</Button>
            <Button onClick={() => setStage(3)} disabled={!canConfirm && !(invalidRows.length === 0 && duplicateCount === 0)}>Continue to import <span aria-hidden="true">→</span></Button>
          </div>
          {!canConfirm ? <InlineAlert tone="warn" title="Resolve before importing">Fix invalid rows and duplicates, or go back to adjust the column mapping. The import action stays disabled until every row is valid.</InlineAlert> : null}
        </section>
      ) : null}

      {/* Stage 3 — Import confirmation */}
      {fileInfo && stage === 3 ? (
        <section aria-label="Confirm import">
          <div className="confirm-card">
            <h3>Confirm database write</h3>
            <p>This action writes to the backend database. It will <b>create new offers and update existing ones</b> (upsert) keyed by <code>offerId</code> (vendor ID + product). Importing the same file twice updates the same offers rather than duplicating them.</p>
            <ul className="confirm-list">
              <li><span>Rows to import</span><b>{validRows.length}</b></li>
              <li><span>Rows rejected</span><b>{invalidRows.length}</b></li>
              <li><span>Duplicate IDs in file</span><b>{duplicateCount}</b></li>
              <li><span>Source</span><b>{fileInfo.name} · {sheetName}</b></li>
            </ul>
            {importError ? <div className="form-error" role="alert">{importError}</div> : null}
            <div className="wizard-footer">
              <Button variant="secondary" onClick={() => setStage(2)} disabled={importing}>← Back to review</Button>
              <Button onClick={() => setConfirmOpen(true)} disabled={importing || !canConfirm}>{importing ? 'Importing…' : `Import ${validRows.length} offers`}</Button>
            </div>
            <p className="muted-note">The button is disabled while the request is in flight to prevent duplicate submissions.</p>
          </div>
          {confirmOpen ? (
            <div className="dialog-scrim" onClick={() => setConfirmOpen(false)}>
              <div className="dialog" role="dialog" aria-modal="true" aria-label="Confirm import" onClick={(e) => e.stopPropagation()}>
                <h3>Import {validRows.length} offers?</h3>
                <p>Offers will be upserted by <code>offerId</code> in the connected backend. This cannot be undone from this screen.</p>
                <div className="dialog-actions">
                  <Button variant="secondary" onClick={() => setConfirmOpen(false)}>Cancel</Button>
                  <Button onClick={doImport} disabled={importing}>{importing ? 'Importing…' : 'Confirm import'}</Button>
                </div>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* Stage 4 — Results */}
      {stage === 4 ? (
        <section aria-label="Import results">
          {importResult ? (
            <div className="result-card success">
              <StatusBadge tone="ok">Import complete</StatusBadge>
              <h3>{importResult.received ?? validRows.length} offers submitted</h3>
              <p>Backend confirmation: {importResult.inserted != null ? `${importResult.inserted} inserted` : ''}{importResult.updated != null ? ` · ${importResult.updated} updated` : ''}. What was persisted is shown below — this message comes from the server, not from the browser finishing its handler.</p>
              <ul className="confirm-list">
                <li><span>File</span><b>{fileInfo?.name}</b></li>
                <li><span>Worksheet</span><b>{sheetName}</b></li>
                <li><span>Rows read</span><b>{rows.length}</b></li>
              </ul>
            </div>
          ) : (
            <div className="result-card">
              <StatusBadge tone="warn">No result yet</StatusBadge>
              <p>Nothing has been imported in this session.</p>
            </div>
          )}
          {importError ? <div className="form-error" role="alert">{importError}</div> : null}
          <div className="wizard-footer">
            <Button variant="secondary" onClick={() => setStage(2)}>Back to review</Button>
            <Button variant="secondary" onClick={resetAll}>Import another file</Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
