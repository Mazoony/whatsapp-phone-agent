import ExcelJS from 'exceljs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPhoneJid } from './phonebook.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const STUDENT_WORKBOOK_FILE = path.join(ROOT_DIR, 'data', 'students.xlsx');
const STUDENT_SOURCES = new Set([
  'chat_history.json',
  'contacts.json',
  'student_progress.json',
  'lessons.json'
]);

function isDirectJid(jid) {
  return typeof jid === 'string' &&
    (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));
}

function timestampMs(timestamp) {
  const value = Number(timestamp) || 0;
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function studentKey(jid, contact) {
  return getPhoneJid(jid, contact?.phoneJid, contact?.jid) || jid;
}

function workbookData(data) {
  const students = new Map();
  const ensureStudent = jid => {
    if (!isDirectJid(jid)) return null;
    const contact = data.contacts[jid] || {};
    const key = studentKey(jid, contact);
    let student = students.get(key);
    if (!student) {
      student = {
        key,
        phoneJid: getPhoneJid(key, contact.phoneJid, contact.jid) || '',
        name: '',
        isEs: false,
        savedInAddressBook: false,
        ownerBlocked: false,
        ownerAllowed: false,
        jids: new Set(),
        messages: [],
        progress: null
      };
      students.set(key, student);
    }
    student.jids.add(jid);
    if (contact.name && (!student.name || contact.name.length > student.name.length)) {
      student.name = contact.name;
    }
    student.isEs ||= contact.isEs === true;
    student.savedInAddressBook ||= contact.savedInAddressBook === true;
    student.ownerBlocked ||= contact.ownerBlocked === true;
    student.ownerAllowed ||= contact.ownerAllowed === true;
    if (contact.phoneJid) student.phoneJid = getPhoneJid(contact.phoneJid) || student.phoneJid;
    return student;
  };

  for (const jid of Object.keys(data.contacts)) ensureStudent(jid);
  for (const [jid, progress] of Object.entries(data.progress)) {
    const student = ensureStudent(jid);
    if (student) student.progress = progress;
  }
  for (const [jid, messages] of Object.entries(data.history)) {
    const student = ensureStudent(jid);
    if (student && Array.isArray(messages)) student.messages.push(...messages);
  }

  const studentsList = [...students.values()].map(student => {
    student.messages.sort((left, right) =>
      timestampMs(left.timestamp) - timestampMs(right.timestamp));
    const latestMessage = student.messages.at(-1);
    const progress = student.progress;
    const grade = progress?.grade || '';
    const gradeData = data.lessons[grade];
    const lesson = gradeData?.lessons?.[progress?.currentLessonIndex] ||
      gradeData?.standaloneLessons?.find(item => item.id === progress?.currentLessonId);
    const phoneNumber = student.phoneJid
      ? student.phoneJid.slice(0, -'@s.whatsapp.net'.length).split(':')[0]
      : '';

    return {
      key: student.key,
      name: student.name || phoneNumber || student.key,
      phoneNumber,
      whatsappIds: [...student.jids].sort().join(', '),
      isEs: student.isEs ? 'Yes' : 'No',
      savedInAddressBook: student.savedInAddressBook ? 'Yes' : 'No',
      ownerBlocked: student.ownerBlocked ? 'Yes' : 'No',
      ownerAllowed: student.ownerAllowed ? 'Yes' : 'No',
      grade: gradeData?.name || grade,
      currentLesson: lesson?.title || progress?.currentLessonId || '',
      lessonStatus: progress?.status || '',
      lessonDeliveredAt: progress?.deliveredAt ? new Date(progress.deliveredAt) : null,
      messageCount: student.messages.length,
      lastMessageAt: latestMessage?.timestamp ? new Date(timestampMs(latestMessage.timestamp)) : null,
      lastMessageFrom: latestMessage?.role === 'client'
        ? 'Student'
        : latestMessage?.role === 'agent' ? 'Agent' : '',
      lastMessage: latestMessage?.text || '',
      messages: student.messages.map(message => ({
        timestamp: message.timestamp ? new Date(timestampMs(message.timestamp)) : null,
        sender: message.role === 'client' ? 'Student' : message.role === 'agent' ? 'Agent' : message.role,
        text: message.text || ''
      }))
    };
  }).sort((left, right) => left.name.localeCompare(right.name));

  return { students: studentsList };
}

function configureWorksheet(sheet, columns) {
  sheet.columns = columns;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF176B4D' }
  };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length }
  };
}

export async function writeStudentWorkbook(data, filePath = STUDENT_WORKBOOK_FILE) {
  const { students } = workbookData(data);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'WhatsApp Phone Agent';
  workbook.created = new Date();
  workbook.modified = new Date();

  const studentSheet = workbook.addWorksheet('Students');
  const studentColumns = [
    { header: 'Student name', key: 'name', width: 32 },
    { header: 'Phone number', key: 'phoneNumber', width: 18 },
    { header: 'WhatsApp IDs', key: 'whatsappIds', width: 38 },
    { header: 'Es contact', key: 'isEs', width: 12 },
    { header: 'Saved in address book', key: 'savedInAddressBook', width: 22 },
    { header: 'Owner blocked', key: 'ownerBlocked', width: 15 },
    { header: 'Owner allowed', key: 'ownerAllowed', width: 15 },
    { header: 'Grade', key: 'grade', width: 26 },
    { header: 'Current lesson', key: 'currentLesson', width: 48 },
    { header: 'Lesson status', key: 'lessonStatus', width: 19 },
    { header: 'Lesson delivered at', key: 'lessonDeliveredAt', width: 23, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'Saved messages', key: 'messageCount', width: 16 },
    { header: 'Last message at', key: 'lastMessageAt', width: 23, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'Last message from', key: 'lastMessageFrom', width: 20 },
    { header: 'Latest message', key: 'lastMessage', width: 70 }
  ];
  configureWorksheet(studentSheet, studentColumns);
  studentSheet.addRows(students.map(({ messages, key, ...student }) => student));

  const conversationSheet = workbook.addWorksheet('Conversation History');
  const conversationColumns = [
    { header: 'Student name', key: 'name', width: 32 },
    { header: 'Phone number', key: 'phoneNumber', width: 18 },
    { header: 'WhatsApp IDs', key: 'whatsappIds', width: 38 },
    { header: 'Timestamp', key: 'timestamp', width: 23, style: { numFmt: 'yyyy-mm-dd hh:mm:ss' } },
    { header: 'Sender', key: 'sender', width: 18 },
    { header: 'Message', key: 'text', width: 100 }
  ];
  configureWorksheet(conversationSheet, conversationColumns);
  for (const student of students) {
    for (const message of student.messages) {
      conversationSheet.addRow({
        name: student.name,
        phoneNumber: student.phoneNumber,
        whatsappIds: student.whatsappIds,
        ...message
      });
    }
  }

  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await workbook.xlsx.writeFile(temporaryPath);
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    try {
      await fs.promises.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        console.error('[Student Workbook] Could not remove temporary workbook:', cleanupError.message);
      }
    }
    throw error;
  }

  return {
    filePath,
    students: students.length,
    messages: students.reduce((total, student) => total + student.messages.length, 0),
    updatedAt: new Date().toISOString()
  };
}

export function createStudentWorkbookManager({
  readData,
  filePath = STUDENT_WORKBOOK_FILE,
  onUpdated = () => {}
}) {
  let refreshPromise = null;
  let refreshAgain = false;
  let generated = false;
  let status = {
    state: 'updating',
    fileName: path.basename(filePath),
    updatedAt: null,
    students: 0,
    messages: 0,
    error: null
  };

  async function refresh() {
    if (refreshPromise) {
      refreshAgain = true;
      return refreshPromise;
    }

    refreshPromise = (async () => {
      do {
        refreshAgain = false;
        status = { ...status, state: 'updating', error: null };
        try {
          const result = await writeStudentWorkbook(readData(), filePath);
          status = {
            state: 'ready',
            fileName: path.basename(filePath),
            updatedAt: result.updatedAt,
            students: result.students,
            messages: result.messages,
            error: null
          };
          generated = true;
        } catch (error) {
          status = { ...status, state: 'error', error: error.message };
          console.error('[Student Workbook] Could not update Excel file:', error.message);
        }
        try {
          onUpdated({ ...status });
        } catch (error) {
          console.error('[Student Workbook] Could not notify dashboard:', error.message);
        }
      } while (refreshAgain);
    })();

    try {
      await refreshPromise;
    } finally {
      refreshPromise = null;
    }
    return { ...status };
  }

  async function getStatus() {
    if (!generated && !refreshPromise) await refresh();
    else if (refreshPromise) await refreshPromise;
    return { ...status };
  }

  async function waitForRefresh() {
    if (refreshPromise) await refreshPromise;
  }

  return { refresh, getStatus, waitForRefresh };
}

export const STUDENT_WORKBOOK_SOURCE_FILES = STUDENT_SOURCES;
