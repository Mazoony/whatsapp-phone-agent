import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SUDANESE_STYLE_FILE = path.join(ROOT_DIR, 'data', 'sudanese_arabic_style.json');

const DIALECT_CUES = [
  'هسي',
  'شنو',
  'وريني',
  'رسل لي',
  'رسلي',
  'طوالي',
  'شديد',
  'كيفن',
  'مافي',
  'ما في',
  'دا',
  'دي',
  'ديل',
  'عايز',
  'عايزة',
  'معاك',
  'معاكي',
  'إنت',
  'إنتي',
  'محتاج',
  'محتاجة',
  'ماشي',
  'ماشة',
  'ما تشيل هم',
  'ما تشيلي هم',
  'ولا يهمك',
  'يا زول',
  'يا زولة',
  'كويس',
  'كويسة',
  'بالجد',
  'كدي',
  'براك',
  'براكي'
];

function normalizeArabic(text) {
  return text
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي');
}

function matchesCue(text, cue) {
  const escapedCue = cue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapedCue}(?=$|[^\\p{L}\\p{N}])`, 'u').test(text);
}

function readProfile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, totalMessages: 0, cues: {} };
    throw error;
  }
  if (!parsed || parsed.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.totalMessages) || parsed.totalMessages < 0 ||
      !parsed.cues || typeof parsed.cues !== 'object' || Array.isArray(parsed.cues)) {
    throw new Error(`Invalid Sudanese Arabic style profile: ${filePath}`);
  }
  for (const [cue, count] of Object.entries(parsed.cues)) {
    if (!DIALECT_CUES.includes(cue) || !Number.isSafeInteger(count) || count < 1) {
      throw new Error(`Invalid Sudanese Arabic style cue in profile: ${filePath}`);
    }
  }
  return parsed;
}

function writeProfile(filePath, profile) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(profile, null, 2), 'utf8');
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      console.error('[Arabic Learning] Could not remove temporary file:', cleanupError.message);
    }
    throw error;
  }
}

export function observeSudaneseArabicMessage(text, filePath = SUDANESE_STYLE_FILE) {
  if (typeof text !== 'string' || !text.trim()) {
    return { totalMessages: null, observedCues: [], newCues: [] };
  }

  const profile = readProfile(filePath);
  const normalizedText = normalizeArabic(text.slice(0, 5000));
  const observedCues = DIALECT_CUES.filter(cue => matchesCue(normalizedText, normalizeArabic(cue)));
  const newCues = observedCues.filter(cue => !profile.cues[cue]);

  profile.totalMessages += 1;
  for (const cue of observedCues) {
    profile.cues[cue] = (profile.cues[cue] || 0) + 1;
  }
  writeProfile(filePath, profile);

  return {
    totalMessages: profile.totalMessages,
    observedCues,
    newCues
  };
}

export function getSudaneseArabicStyleContext(filePath = SUDANESE_STYLE_FILE) {
  const profile = readProfile(filePath);
  const cues = Object.entries(profile.cues)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 12);
  if (!cues.length) return '';

  return [
    'Observed Sudanese Arabic cues in recent client messages (local aggregate counts; examples only):',
    ...cues.map(([cue, count]) => `- "${cue}" (observed ${count} ${count === 1 ? 'time' : 'times'})`)
  ].join('\n');
}

export const sudaneseArabicLearner = {
  observe(text) {
    return observeSudaneseArabicMessage(text);
  },
  getContext() {
    return getSudaneseArabicStyleContext();
  }
};
