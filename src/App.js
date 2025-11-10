import React, { useState, useEffect } from 'react';
import { PDFDocument, PDFName, PDFString, PDFHexString } from 'pdf-lib';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';
import { saveAs } from 'file-saver';

const FIELD_MAP = {
  // Map PDF field names → DOCX placeholders
  // 'PDF Field Name': 'docx_placeholder',
  // Example:
  // 'FirstName': 'firstName',
  // 'LastName': 'lastName',
  // 'IsMemberCheckbox': 'isMember'
};

function normalizeFieldValue(value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (value == null) return '';
  return String(value);
}

function mapPdfDataToDocxPlaceholders(pdfData) {
  const mapped = {};
  Object.entries(pdfData).forEach(([pdfFieldName, value]) => {
    const targetKey = FIELD_MAP[pdfFieldName] ?? pdfFieldName;
    mapped[targetKey] = normalizeFieldValue(value);
  });
  return mapped;
}

function App() {
  const [pdfUrl, setPdfUrl] = useState('/form.pdf');
  const [pdfBytes, setPdfBytes] = useState(null);
  const [isFlattened, setIsFlattened] = useState(false);

  // Load default PDF on mount (optional)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/form.pdf');
        const buf = await res.arrayBuffer();
        setPdfBytes(buf);
        setPdfUrl('/form.pdf');
      } catch (e) {
        console.warn('Could not load /form.pdf', e);
      }
    })();
  }, []);

  // NEW: handle user-uploaded (possibly filled) PDF
  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buf = await file.arrayBuffer();
    setPdfBytes(buf);
    setIsFlattened(false);
    // show the uploaded file in the iframe
    const url = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
    setPdfUrl(url);
  };

  // Robust extractor: reads /V and falls back to /RV for text
  async function extractPdfFieldValues(bytes) {
    const pdfDoc = await PDFDocument.load(bytes);
    const form = pdfDoc.getForm();
    const fields = form.getFields();

    const data = {};
    for (const field of fields) {
      const name = field.getName();

      // TEXT
      if (typeof field.getText === 'function') {
        let val = field.getText() ?? '';
        if (!val) {
          try {
            // @ts-ignore
            const acro = field.acroField;
            const rvObj = acro?.dict?.get?.(PDFName.of('RV'));
            if (rvObj) {
              if (rvObj instanceof PDFString && typeof rvObj.decodeText === 'function') {
                val = rvObj.decodeText();
              } else if (rvObj instanceof PDFHexString && typeof rvObj.decodeText === 'function') {
                val = rvObj.decodeText();
              } else if (rvObj instanceof PDFString && 'value' in rvObj) {
                // @ts-ignore
                val = rvObj.value || '';
              } else {
                val = String(rvObj);
              }
            }
          } catch {}
        }
        data[name] = val;
        continue;
      }

      // CHECKBOX
      if (typeof field.isChecked === 'function') {
        data[name] = field.isChecked();
        continue;
      }

      // RADIO / DROPDOWN
      if (typeof field.getSelected === 'function') {
        data[name] = field.getSelected?.() ?? '';
        continue;
      }

      data[name] = '';
    }

    return data;
  }

  const exportJson = async () => {
    if (!pdfBytes) {

     alert('Load a PDF first (upload or default).');
     return;
    }


    // Important: the iframe is not editable in a way you can capture.
    // You must upload the already-filled PDF, or fill via your React UI.
    try {
      const data = await extractPdfFieldValues(pdfBytes);
      console.log('Extracted data:', data);
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      const a = document.createElement('a');
      a.href = url;
      a.download = `form-data-${ts}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error('Export JSON failed', e);
      alert('Export JSON failed. See console.');
    }
  };

  async function logPdfFormFields(file) {
    const pdfDoc = await PDFDocument.load(file);
    const form = pdfDoc.getForm();
    const fields = form.getFields();

    const formData = {};
    fields.forEach(field => {
      const name = field.getName();
      const value = field.getValue();
      formData[name] = value;
    });

    console.log('PDF Form Field Values:', formData);
  }

  const savePdf = async () => {
    if (!pdfBytes) return alert('Load a PDF first.');

    const pdfDoc = await PDFDocument.load(pdfBytes);
    const form = pdfDoc.getForm();
    form.flatten();

    const newBytes = await pdfDoc.save();

    const blob = new Blob([newBytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    setPdfUrl(url);
    setPdfBytes(newBytes);   // NOTE: this overwrites with flattened bytes (no fields)
    setIsFlattened(true);
  };

  // Optional: debug values in console (to confirm you see paragraphs)
  const debugLogValues = async () => {
    if (!pdfBytes) return alert('Load a PDF first.');
    const data = await extractPdfFieldValues(pdfBytes);
    console.table(data);
  };

  const exportDocx = async () => {
    if (!pdfBytes)
      { alert('Load a PDF first (upload or default).');
        return;
      }

    try {
      console.log('[docx] extracting PDF fields...');
      const pdfData = await extractPdfFieldValues(pdfBytes);
      console.log('[docx] pdfData: ', pdfData);
      const docxData = mapPdfDataToDocxPlaceholders(pdfData);
      console.log('[docx] mapped data:', docxData);

      //console.log('[docx] fetching /template.docx...');
      //const templateRes = await fetch('/template.docx');
      const templateUrl = `${window.location.origin}/template.docx`;
      const templateRes = await fetch(templateUrl, {
        cache: 'no-store',
        credentials: 'same-origin',
      });

      console.log('[docx] response status:', templateRes.status, templateRes.statusText);
      if (!templateRes.ok) {
        throw new Error(`Failed to load template.docx: ${templateRes.status} ${templateRes.statusText}`);
      }
      const templateBuffer = await templateRes.arrayBuffer();
      console.log('[docx] template size:', templateBuffer.byteLength);

      const zip = new PizZip(templateBuffer);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
      });

      doc.render(docxData);

      const out = doc.getZip().generate({
        type: 'blob',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });

      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      saveAs(out, `filled-template-${ts}.docx`);
    }catch (err) {
     console.error('Export DOCX failed:', err);
     err.properties?.errors?.forEach(subErr => {
       console.error('Docxtemplater explanation:', subErr.properties.explanation);
       console.error('Offending tag:', subErr.properties.id);
     });
     alert('Export DOCX failed. Check the console.');
   }
  };

  return (
    <div style={{ padding: 12 }}>
      <h2>Fillable PDF Viewer</h2>

      <div style={{ marginBottom: 8 }}>
        <input type="file" accept="application/pdf" onChange={onFile} />
        <small style={{ display: 'block', color: '#666' }}>
          Tip: upload a PDF that is already filled (from Acrobat) — typing inside this iframe won’t update the bytes your app can read.
        </small>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <button onClick={exportJson} disabled={!pdfBytes}>Export JSON</button>
        <button onClick={debugLogValues} disabled={!pdfBytes}>Debug: Log Values</button>
        <button onClick={exportDocx} disabled={!pdfBytes}>Export DOCX</button>
      </div>

      <iframe
        title="PDF Viewer"
        src={pdfUrl}
        width={800}
        height={1122}
        style={{ border: '1px solid #999', marginTop: 10 }}
      />

      {isFlattened && (
        <p style={{ color: '#555' }}>
          PDF flattened. Fields are now static; export values before flattening.
        </p>
      )}
    </div>
  );
}

export default App;