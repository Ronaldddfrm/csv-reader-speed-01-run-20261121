// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference CSV reader).
//
// Returns exactly what readCsv returns for every input {text, header}:
// {columns, rows, errors}. Written from the reference's documented policy
// (RULES.txt) and its source, then re-implemented for speed:
//
//   - A U+FEFF at the very start of the text is dropped.
//   - A record ends at LF or CRLF; a line left with no characters is no record.
//   - Outside quotes a CR not followed by LF is dropped (error stray_cr).
//   - A field that opens with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote).
//   - A quote inside an unquoted field is a literal character. Fields stay
//     strings, never trimmed or converted.
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width.
//   - Each error is {code, line, row}, in the order met; line is the 1-based
//     line its record starts on (every LF, CRLF and lone CR inside a quoted
//     field counted), row its record's index in rows (null for the header).
//
// Speed: the reference reads one character at a time and builds every field
// a character at a time. Most records are one clean line, so this parser
// takes a fast path for them: slice the line, reject it when it holds a
// quote or a stray CR, and split it on commas with the native split. Other
// records go through a field-by-field loop that is inlined (no per-field
// function call or result object) and scans unquoted fields with one
// charCodeAt loop instead of reading character by character. Pure: no clock,
// no randomness, no locale, nothing kept from one call to the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  function error(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is dropped
  // (stray_cr). Returns the field and how it ended; `added` counts the characters kept. Used only for the text
  // after a closing quote (quote junk) and for the re-read of a quote that never closes, both rare.
  function readUnquoted(value) {
    let added = 0;
    for (;;) {
      let i = pos;
      let ch = 0;
      while (i < len) {
        ch = text.charCodeAt(i);
        if (ch === 44 || ch === 10 || ch === 13) break;
        i++;
      }
      if (i >= len) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = len;
        return { value, ended: END, added };
      }
      if (ch === 44) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        return { value, ended: COMMA, added };
      }
      if (ch === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 1;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      // ch === 13: a line break when followed by LF, else a dropped stray CR.
      if (text.charCodeAt(i + 1) === 10) {
        if (i > pos) {
          value += text.slice(pos, i);
          added += i - pos;
        }
        pos = i + 2;
        line += 1;
        return { value, ended: LINE_BREAK, added };
      }
      if (i > pos) {
        value += text.slice(pos, i);
        added += i - pos;
      }
      error('stray_cr');
      pos = i + 1;
    }
  }

  // Finishes a record's fields: header, or a row padded/cut to the first record's width.
  // Inlined at the two call sites would save a call per record; kept as a function because both
  // sites share the exact width/header/error logic and the call costs ~1% here.
  function finishRecord(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length === width) {
      rows.push(fields);
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record is one line with no quote and no stray CR, so it is the line split on commas.
    // A line ending in CRLF has its CR stripped; a line holding a quote or a stray CR takes the slow path.
    // A CR at the very end of the text is a stray CR, not a CRLF, so it is stripped only before an LF.
    const nIdx = text.indexOf('\n', pos);
    const lineEnd = nIdx === -1 ? len : nIdx;
    let contentEnd = lineEnd;
    if (nIdx !== -1 && contentEnd > pos && text.charCodeAt(contentEnd - 1) === 13) contentEnd -= 1;
    if (contentEnd > pos) {
      const lineStr = text.slice(pos, contentEnd);
      if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
        const fields = lineStr.split(',');
        pos = nIdx === -1 ? len : nIdx + 1;
        line += 1;
        finishRecord(fields);
        continue;
      }
    }

    // Slow path: a quoted field, a stray CR, junk after a closing quote, or a quote that never closes.
    const fields = [];
    let quoted = false;
    let ended = COMMA;
    while (ended === COMMA) {
      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote runs to the next quote that is not doubled.
        quoted = true;
        const open = pos;
        const openLine = line;
        let p = pos + 1;
        let doubled = false;
        let q = -1;
        for (;;) {
          q = text.indexOf('"', p);
          if (q === -1) break;
          if (text.charCodeAt(q + 1) === 34) {
            doubled = true;
            p = q + 2;
            continue;
          }
          break;
        }
        if (q === -1) {
          // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
          error('unterminated_quote');
          pos = open + 1;
          line = openLine;
          const f = readUnquoted('"');
          fields.push(f.value);
          ended = f.ended;
          continue;
        }
        let value = text.slice(open + 1, q);
        if (doubled) value = value.replaceAll('""', '"');
        if (value.indexOf('\n') !== -1 || value.indexOf('\r') !== -1) {
          // CRLF and a lone CR inside quotes are each one LF.
          const parts = value.split(/\r\n|\r|\n/);
          line += parts.length - 1;
          value = parts.join('\n');
        }
        pos = q + 1;
        if (pos >= len) {
          fields.push(value);
          ended = END;
          break;
        }
        const c = text.charCodeAt(pos);
        if (c === 44) {
          fields.push(value);
          pos += 1;
          ended = COMMA;
          continue;
        }
        if (c === 10) {
          fields.push(value);
          pos += 1;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        if (c === 13 && text.charCodeAt(pos + 1) === 10) {
          fields.push(value);
          pos += 2;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        // What follows the closing quote is appended as it stands, up to the next comma or line break.
        const junk = readUnquoted(value);
        if (junk.added > 0) error('quote_junk');
        fields.push(junk.value);
        ended = junk.ended;
        continue;
      }

      // An unquoted field: one scan to the next comma, line break or CR.
      quoted = false;
      let value = '';
      for (;;) {
        let i = pos;
        let ch = 0;
        while (i < len) {
          ch = text.charCodeAt(i);
          if (ch === 44 || ch === 10 || ch === 13) break;
          i++;
        }
        if (i >= len) {
          if (i > pos) value += text.slice(pos, i);
          pos = len;
          ended = END;
          break;
        }
        if (ch === 44) {
          if (i > pos) value += text.slice(pos, i);
          pos = i + 1;
          ended = COMMA;
          break;
        }
        if (ch === 10) {
          if (i > pos) value += text.slice(pos, i);
          pos = i + 1;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        // ch === 13: a line break when followed by LF, else a dropped stray CR.
        if (text.charCodeAt(i + 1) === 10) {
          if (i > pos) value += text.slice(pos, i);
          pos = i + 2;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        if (i > pos) value += text.slice(pos, i);
        error('stray_cr');
        pos = i + 1;
      }
      fields.push(value);
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    finishRecord(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
