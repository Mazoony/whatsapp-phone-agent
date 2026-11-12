import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { google } from 'googleapis';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const OVERVIEW_GOOGLE_SHEET_STATE_FILE = path.join(
  ROOT_DIR,
  'data',
  'overview_google_sheet.json'
);
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
const SHEET_NAMES = ['Daily Overview', 'Class History', 'Telegram Activity'];

function createGoogleApiClient(credentials) {
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file'
    ]
  });
  return {
    sheets: google.sheets({ version: 'v4', auth }),
    drive: google.drive({ version: 'v3', auth })
  };
}

function readStoredSpreadsheet(stateFilePath) {
  if (!fs.existsSync(stateFilePath)) return null;
  const state = JSON.parse(fs.readFileSync(stateFilePath, 'utf8'));
  if (typeof state.spreadsheetId !== 'string' || !state.spreadsheetId) {
    throw new Error('Stored Google spreadsheet state is invalid.');
  }
  return state;
}

function saveStoredSpreadsheet(stateFilePath, state) {
  fs.mkdirSync(path.dirname(stateFilePath), { recursive: true });
  const temporaryPath = `${stateFilePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(temporaryPath, stateFilePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Google Sheets] Could not remove temporary state file:', cleanupError.message);
    }
    throw error;
  }
}

function valueCell(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { userEnteredValue: { numberValue: value } };
  }
  if (typeof value === 'boolean') {
    return { userEnteredValue: { boolValue: value } };
  }
  if (value === null || value === undefined || value === '') return {};
  return { userEnteredValue: { stringValue: String(value) } };
}

function toSheetRows(workbook, sheetName) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Local Overview workbook is missing the "${sheetName}" sheet.`);
  const rows = [];
  sheet.eachRow({ includeEmpty: true }, row => {
    rows[row.number - 1] = row.values.slice(1).map(value => value ?? '');
  });
  return rows;
}

function quotedRange(sheetName) {
  return `'${sheetName.replaceAll("'", "''")}'!A:ZZ`;
}

function getTableSize(rows) {
  return {
    rowCount: rows.length,
    columnCount: rows.reduce((max, row) => Math.max(max, row.length), 0)
  };
}

export function createGoogleSheetsOverviewManager({
  workbookFilePath,
  stateFilePath = OVERVIEW_GOOGLE_SHEET_STATE_FILE,
  credentialsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
  shareWith = process.env.GOOGLE_SHEETS_SHARE_WITH || '',
  spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID || '',
  createClient = createGoogleApiClient,
  onUpdated = () => {}
}) {
  if (typeof workbookFilePath !== 'string' || !workbookFilePath) {
    throw new TypeError('Overview workbook path is required for Google Sheets sync.');
  }
  if (typeof createClient !== 'function') {
    throw new TypeError('Google Sheets client factory must be a function.');
  }

  let refreshPromise = null;
  let timer = null;
  let stopped = false;
  let storedState = null;
  let status = {
    state: 'not_configured',
    spreadsheetId: null,
    spreadsheetUrl: null,
    serviceAccountEmail: null,
    updatedAt: null,
    error: null
  };

  function notify() {
    try {
      onUpdated({ ...status });
    } catch (error) {
      console.error('[Google Sheets] Could not notify dashboard:', error.message);
    }
  }

  async function getSpreadsheetState(client, credentials) {
    storedState ||= readStoredSpreadsheet(stateFilePath);
    const activeSpreadsheetId = spreadsheetId || storedState?.spreadsheetId;
    if (activeSpreadsheetId) {
      const response = await client.sheets.spreadsheets.get({
        spreadsheetId: activeSpreadsheetId,
        fields: 'spreadsheetId,spreadsheetUrl,sheets.properties'
      });
      return {
        spreadsheetId: response.data.spreadsheetId,
        spreadsheetUrl: response.data.spreadsheetUrl,
        sheets: response.data.sheets || []
      };
    }

    const response = await client.sheets.spreadsheets.create({
      requestBody: {
        properties: { title: 'Telegram Daily Overview' },
        sheets: SHEET_NAMES.map(title => ({ properties: { title } }))
      },
      fields: 'spreadsheetId,spreadsheetUrl,sheets.properties'
    });
    const created = {
      spreadsheetId: response.data.spreadsheetId,
      spreadsheetUrl: response.data.spreadsheetUrl,
      sheets: response.data.sheets || []
    };
    if (!created.spreadsheetId || !created.spreadsheetUrl) {
      throw new Error('Google did not return the new spreadsheet ID and URL.');
    }
    storedState = {
      spreadsheetId: created.spreadsheetId,
      spreadsheetUrl: created.spreadsheetUrl,
      createdAt: new Date().toISOString()
    };
    saveStoredSpreadsheet(stateFilePath, storedState);

    return created;
  }

  async function ensureShared(client, activeSpreadsheetId, credentials) {
    if (!shareWith || shareWith.toLowerCase() === credentials.client_email.toLowerCase()) return;
    if (!client.drive) {
      throw new Error('Google Drive client is required to share the spreadsheet.');
    }
    const response = await client.drive.permissions.list({
      fileId: activeSpreadsheetId,
      fields: 'permissions(emailAddress,role,type)'
    });
    const alreadyShared = (response.data.permissions || []).some(permission =>
      permission.type === 'user' &&
      permission.emailAddress?.toLowerCase() === shareWith.toLowerCase()
    );
    if (!alreadyShared) {
      await client.drive.permissions.create({
        fileId: activeSpreadsheetId,
        requestBody: { type: 'user', role: 'reader', emailAddress: shareWith },
        sendNotificationEmail: true,
        fields: 'id'
      });
    }
  }

  async function ensureTabs(client, spreadsheet) {
    const existingTitles = new Set(spreadsheet.sheets.map(sheet => sheet.properties?.title));
    const missingTitles = SHEET_NAMES.filter(title => !existingTitles.has(title));
    if (missingTitles.length) {
      await client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: spreadsheet.spreadsheetId,
        requestBody: {
          requests: missingTitles.map(title => ({ addSheet: { properties: { title } } }))
        }
      });
      const response = await client.sheets.spreadsheets.get({
        spreadsheetId: spreadsheet.spreadsheetId,
        fields: 'spreadsheetId,spreadsheetUrl,sheets.properties'
      });
      spreadsheet.sheets = response.data.sheets || [];
    }
  }

  async function syncWorkbook(client, spreadsheet) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(workbookFilePath);
    const sheetRows = SHEET_NAMES.map(title => ({ title, rows: toSheetRows(workbook, title) }));
    const currentResponse = await client.sheets.spreadsheets.values.batchGet({
      spreadsheetId: spreadsheet.spreadsheetId,
      ranges: SHEET_NAMES.map(quotedRange)
    });
    const currentRows = new Map((currentResponse.data.valueRanges || []).map((range, index) => [
      SHEET_NAMES[index],
      range.values || []
    ]));
    const sheetIds = new Map(spreadsheet.sheets.map(sheet => [
      sheet.properties.title,
      sheet.properties.sheetId
    ]));

    const requests = sheetRows.map(({ title, rows }) => {
      const currentSize = getTableSize(currentRows.get(title) || []);
      const nextSize = getTableSize(rows);
      const rowCount = Math.max(currentSize.rowCount, nextSize.rowCount);
      const columnCount = Math.max(currentSize.columnCount, nextSize.columnCount);
      const updateRows = Array.from({ length: rowCount }, (_, rowIndex) => ({
        values: Array.from({ length: columnCount }, (_, columnIndex) =>
          valueCell(rows[rowIndex]?.[columnIndex]))
      }));
      return {
        updateCells: {
          range: {
            sheetId: sheetIds.get(title),
            startRowIndex: 0,
            endRowIndex: rowCount,
            startColumnIndex: 0,
            endColumnIndex: columnCount
          },
          rows: updateRows,
          fields: 'userEnteredValue'
        }
      };
    });

    await client.sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheet.spreadsheetId,
      requestBody: { requests }
    });
    return workbook.getWorksheet('Daily Overview').rowCount - 1;
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    if (!credentialsJson) {
      status = {
        ...status,
        state: 'not_configured',
        error: 'Set GOOGLE_SERVICE_ACCOUNT_JSON to enable Google Sheets sync.'
      };
      notify();
      return { ...status };
    }

    refreshPromise = (async () => {
      status = { ...status, state: 'syncing', error: null };
      notify();
      try {
        const credentials = JSON.parse(credentialsJson);
        if (typeof credentials.client_email !== 'string' ||
            typeof credentials.private_key !== 'string') {
          throw new Error('Google service account JSON must include client_email and private_key.');
        }
        const client = await createClient(credentials);
        const spreadsheet = await getSpreadsheetState(client, credentials);
        await ensureShared(client, spreadsheet.spreadsheetId, credentials);
        await ensureTabs(client, spreadsheet);
        const snapshots = await syncWorkbook(client, spreadsheet);
        status = {
          state: 'ready',
          spreadsheetId: spreadsheet.spreadsheetId,
          spreadsheetUrl: spreadsheet.spreadsheetUrl,
          serviceAccountEmail: credentials.client_email,
          updatedAt: new Date().toISOString(),
          snapshots,
          error: null
        };
      } catch (error) {
        status = { ...status, state: 'error', error: error.message };
        console.error('[Google Sheets] Could not sync Overview history:', error.message);
      }
      notify();
      return { ...status };
    })();

    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  function schedule(delay) {
    if (stopped) return;
    timer = setTimeout(async () => {
      const result = await refresh();
      schedule(result.state === 'ready' || result.state === 'not_configured'
        ? DAILY_INTERVAL_MS
        : RETRY_INTERVAL_MS);
    }, delay);
    timer.unref?.();
  }

  async function start() {
    stopped = false;
    const result = await refresh();
    schedule(result.state === 'ready' || result.state === 'not_configured'
      ? DAILY_INTERVAL_MS
      : RETRY_INTERVAL_MS);
    return result;
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  async function getStatus() {
    if (refreshPromise) await refreshPromise;
    else if (status.state === 'not_configured' && credentialsJson) await refresh();
    return { ...status };
  }

  return { start, stop, refresh, getStatus };
}
