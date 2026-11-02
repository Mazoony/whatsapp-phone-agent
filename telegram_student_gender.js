import { inferContactGender } from './contact_gender.js';

const FEMALE_NAMES = new Set([
  'آمنة', 'آمنه', 'أماني', 'أسماء', 'إسراء', 'إيمان', 'إيناس', 'ابتسام',
  'انتصار', 'بثينة', 'بسمة', 'تسنيم', 'تهاني', 'حنان', 'خديجة', 'دعاء',
  'داليا', 'رانيا', 'رقية', 'ريم', 'روان', 'سارة', 'سعاد', 'سلمى', 'سمية',
  'سناء', 'شذى', 'صفاء', 'عائشة', 'عزة', 'فاطمة', 'لمياء', 'مريم', 'منى',
  'مها', 'مي', 'ندى', 'نهى', 'هالة', 'هدى', 'هبة', 'وفاء', 'ياسمين',
  'zahra', 'zainab', 'amina', 'amnah', 'amani', 'asma', 'asmaa', 'esraa',
  'israa', 'eman', 'iman', 'inas', 'ibtisam', 'buthaina', 'basma', 'tasneem',
  'tahani', 'hanan', 'khadija', 'doaa', 'dalia', 'rania', 'ruqayya', 'reem',
  'rawan', 'sara', 'sarah', 'souad', 'salma', 'somaya', 'sanaa', 'shatha',
  'safa', 'aisha', 'azza', 'fatima', 'lamia', 'maryam', 'mona', 'maha',
  'mai', 'nada', 'noha', 'hala', 'huda', 'hiba', 'wafaa', 'yasmin'
]);

const FEMININE_REPLACEMENTS = [
  ['إنت مسجل', 'إنتي مسجلة'],
  ['برافو عليك', 'برافو عليكي'],
  ['ما محتاج', 'ما محتاجة'],
  ['ممكن ترسل', 'ممكن ترسلي'],
  ['أرسلها', 'أرسليها'],
  ['ارسلها', 'ارسليها'],
  ['إنت', 'إنتي'],
  ['انت', 'انتي'],
  ['عليك', 'عليكي'],
  ['ليك', 'ليكي'],
  ['داير', 'دايرة'],
  ['عايز', 'عايزة'],
  ['محتاج', 'محتاجة'],
  ['جاهز', 'جاهزة'],
  ['متأكد', 'متأكدة'],
  ['خايف', 'خايفة'],
  ['مبسوط', 'مبسوطة'],
  ['موفق', 'موفقة'],
  ['ممتاز', 'ممتازة'],
  ['واصل', 'واصلي'],
  ['افتح', 'افتحي'],
  ['اضغط', 'اضغطي'],
  ['جرّب', 'جرّبي'],
  ['جرب', 'جربي'],
  ['أرسل', 'أرسلي'],
  ['ارسل', 'ارسلي'],
  ['جاوبت', 'جاوبتي'],
  ['كملت', 'كملتي'],
  ['وضّح', 'وضّحي'],
  ['وضحها', 'وضحيها'],
  ['وضح', 'وضحي'],
  ['راجع', 'راجعي'],
  ['احفظ', 'احفظي']
];

const NEUTRAL_REPLACEMENTS = [
  ['إنت مسجل معانا', 'حسابك مسجل معانا'],
  ['إنت مسجل', 'الحساب مسجل'],
  ['برافو عليك', 'برافو'],
  ['ما محتاج تعيد', 'ما في داعي لإعادة'],
  ['ممكن ترسل', 'يمكن إرسال'],
  ['ممكن تعيد', 'يمكن إعادة'],
  ['رسل لي الأجوبة', 'يرجى إرسال الأجوبة'],
  ['أرسل إجابات الأسئلة دي بس', 'يمكن إرسال إجابات الأسئلة دي بس'],
  ['أرسلها تاني', 'يمكن إعادة إرسالها'],
  ['أرسلها', 'يمكن إعادة إرسالها'],
  ['ارسلها', 'يمكن إعادة إرسالها'],
  ['واصل بالوتيرة المناسبة ليك', 'الاستمرار بالوتيرة المناسبة يساعد على التقدم'],
  ['جاوبت تمرين الحصة', 'تم حل تمرين الحصة'],
  ['كملت 5 دروس', 'تم إكمال 5 دروس'],
  ['اضغط Start', 'يرجى الضغط على Start'],
  ['جرّب', 'يمكن المحاولة'],
  ['جرب', 'يمكن المحاولة'],
  ['وضّحها', 'يمكن توضيحها'],
  ['وضحها', 'يمكن توضيحها'],
  ['أرسل', 'يمكن إرسال'],
  ['ارسل', 'يمكن إرسال'],
  ['افتح', 'يرجى فتح'],
  ['راجع', 'يرجى مراجعة'],
  ['جاوبت', 'تمت الإجابة عن']
];

function normalizeName(name) {
  return String(name || '')
    .normalize('NFKC')
    .replace(/[\u064B-\u065F\u0670]/g, '')
    .trim()
    .split(/[\s._-]+/, 1)[0]
    .toLocaleLowerCase();
}

function replaceWord(text, source, replacement) {
  const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const boundary = String.raw`(^|[^\p{L}\p{N}_])(${escaped})(?=$|[^\p{L}\p{N}_])`;
  return text.replace(new RegExp(boundary, 'giu'), (_match, prefix) => `${prefix}${replacement}`);
}

export function inferTelegramGenderFromName(name) {
  return FEMALE_NAMES.has(normalizeName(name)) ? 'female' : 'unknown';
}

export function inferTelegramGenderFromMessage(text) {
  if (typeof text !== 'string' || !text.trim()) return 'unknown';
  return inferContactGender([{ role: 'client', text }]).value;
}

export function getTelegramStudentGender(student, genderOverride) {
  if (['female', 'male', 'unknown'].includes(genderOverride)) {
    return { value: genderOverride, source: 'manual' };
  }
  if (['female', 'male'].includes(student?.inferredGender)) {
    return {
      value: student.inferredGender,
      source: student.inferredGenderSource || 'inferred'
    };
  }
  const inferred = inferTelegramGenderFromName(student?.name);
  return {
    value: inferred,
    source: inferred === 'female' ? 'inferred from name' : 'unknown'
  };
}

export function personalizeTelegramMessage(text, gender) {
  if (typeof text !== 'string' || gender === 'male') return text;
  const replacements = gender === 'female'
    ? FEMININE_REPLACEMENTS
    : NEUTRAL_REPLACEMENTS;
  return text.split(/(«[^»]*»|“[^”]*”|"[^"]*"|'[^']*')/g)
    .map((part, index) => index % 2
      ? part
      : replacements.reduce(
          (message, [source, replacement]) => replaceWord(message, source, replacement),
          part
        ))
    .join('');
}
