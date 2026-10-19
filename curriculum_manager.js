import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LESSONS_FILE = path.resolve(APP_DIR, 'lessons.json');
export const LESSON_MEDIA_DIR = path.resolve(APP_DIR, 'media', 'lessons');
export const MAX_LESSON_VIDEO_BYTES = 300 * 1024 * 1024;
export const LESSON_COLLECTIONS = {
  treasure_island: {
    gradeKey: 'grade_3_secondary',
    title: 'Treasure Island'
  }
};

export const STAGES = [
  {
    id: 'primary',
    name: 'المرحلة الابتدائية',
    nameEn: 'Primary School',
    years: [1, 2, 3, 4, 5, 6],
    keyPrefix: 'grade_',
    keySuffix: '_primary'
  },
  {
    id: 'intermediate',
    name: 'المرحلة المتوسطة',
    nameEn: 'Intermediate School',
    years: [1, 2, 3],
    keyPrefix: 'grade_',
    keySuffix: '_intermediate'
  },
  {
    id: 'secondary',
    name: 'المرحلة الثانوية',
    nameEn: 'Secondary School',
    years: [1, 2, 3],
    keyPrefix: 'grade_',
    keySuffix: '_secondary'
  }
];

export const ALLOWED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.3gp', '.m4v', '.mkv']);

export function sanitizeVideoFileName(fileName) {
  const baseName = path.basename(String(fileName || '').replace(/[\\/]/g, path.sep));
  const safeName = baseName
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .slice(-180);
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error('A valid video file name is required.');
  }
  const ext = path.extname(safeName).toLowerCase();
  if (!ALLOWED_VIDEO_EXTENSIONS.has(ext)) {
    throw new Error(`Video file format ${ext || 'unknown'} is not supported. Use MP4, MOV, or WEBM.`);
  }
  return safeName;
}

export function parseGradeStage(gradeKey) {
  const match = /^grade_(\d+)_(primary|intermediate|secondary)$/.exec(gradeKey || '');
  if (match) {
    const year = Number(match[1]);
    const stageId = match[2];
    const stage = STAGES.find(s => s.id === stageId);
    return {
      stageId,
      stageName: stage?.name || stageId,
      stageNameEn: stage?.nameEn || stageId,
      year
    };
  }
  return {
    stageId: 'other',
    stageName: 'مراحل أخرى',
    stageNameEn: 'Other Stages',
    year: null
  };
}

export function readLessonsFile(filePath = LESSONS_FILE) {
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeLessonsFileAtomic(filePath = LESSONS_FILE, data = {}) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

export function getDiskVideosForGrade(gradeKey, mediaDir = LESSON_MEDIA_DIR) {
  const gradeMediaDir = path.join(mediaDir, gradeKey);
  if (!fs.existsSync(gradeMediaDir)) return [];

  try {
    const videos = [];
    const visitDirectory = (directory, relativeDirectory = '') => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relativeFile = path.join(relativeDirectory, entry.name);
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visitDirectory(fullPath, relativeFile);
          continue;
        }
        if (!entry.isFile() || !ALLOWED_VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          continue;
        }
        const stats = fs.statSync(fullPath);
        videos.push({
          fileName: entry.name,
          relativePath: `media/lessons/${gradeKey}/${relativeFile.split(path.sep).join('/')}`,
          sizeBytes: stats.size,
          modifiedAt: stats.mtime.toISOString()
        });
      }
    };
    visitDirectory(gradeMediaDir);
    return videos.sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }));
  } catch (err) {
    console.error(`[CurriculumManager] Error listing videos for ${gradeKey}:`, err.message);
    return [];
  }
}

export function listCurriculumOverview(lessonsConfig = null, { filePath = LESSONS_FILE, mediaDir = LESSON_MEDIA_DIR } = {}) {
  const config = lessonsConfig || readLessonsFile(filePath);
  const stagesMap = new Map();

  for (const stage of STAGES) {
    stagesMap.set(stage.id, {
      id: stage.id,
      name: stage.name,
      nameEn: stage.nameEn,
      grades: []
    });
  }

  let totalLessons = 0;
  let gradesWithLessons = 0;
  const gradeKeys = Object.keys(config);

  for (const gradeKey of gradeKeys) {
    const gradeData = config[gradeKey] || {};
    const parsed = parseGradeStage(gradeKey);
    const lessons = Array.isArray(gradeData.lessons) ? gradeData.lessons : [];
    const standaloneLessons = Array.isArray(gradeData.standaloneLessons) ? gradeData.standaloneLessons : [];
    const collectionLessonCount = Object.values(gradeData.collections || {})
      .reduce((total, collection) =>
        total + (Array.isArray(collection?.lessons) ? collection.lessons.length : 0), 0);
    const diskVideos = getDiskVideosForGrade(gradeKey, mediaDir);

    const lessonCount = lessons.length + collectionLessonCount;
    const standaloneCount = standaloneLessons.length;
    const totalForGrade = lessonCount + standaloneCount;

    if (totalForGrade > 0) gradesWithLessons++;
    totalLessons += totalForGrade;

    const gradeSummary = {
      key: gradeKey,
      name: gradeData.name || gradeKey,
      stageId: parsed.stageId,
      stageName: parsed.stageName,
      stageNameEn: parsed.stageNameEn,
      year: parsed.year,
      keywordsCount: Array.isArray(gradeData.keywords) ? gradeData.keywords.length : 0,
      lessonCount,
      collectionLessonCount,
      standaloneLessonCount: standaloneCount,
      totalLessons: totalForGrade,
      diskVideoCount: diskVideos.length
    };

    if (stagesMap.has(parsed.stageId)) {
      stagesMap.get(parsed.stageId).grades.push(gradeSummary);
    } else {
      if (!stagesMap.has('other')) {
        stagesMap.set('other', {
          id: 'other',
          name: 'مراحل أخرى',
          nameEn: 'Other',
          grades: []
        });
      }
      stagesMap.get('other').grades.push(gradeSummary);
    }
  }

  // Sort grades within each stage by year
  for (const stageObj of stagesMap.values()) {
    stageObj.grades.sort((a, b) => (a.year || 0) - (b.year || 0));
  }

  return {
    stages: [...stagesMap.values()],
    totalGrades: gradeKeys.length,
    gradesWithLessons,
    totalLessons
  };
}

export function getGradeCurriculum(gradeKey, lessonsConfig = null, { filePath = LESSONS_FILE, mediaDir = LESSON_MEDIA_DIR, appDir = APP_DIR } = {}) {
  const config = lessonsConfig || readLessonsFile(filePath);
  if (!config[gradeKey]) return null;

  const gradeData = config[gradeKey];
  const parsed = parseGradeStage(gradeKey);
  const diskVideos = getDiskVideosForGrade(gradeKey, mediaDir);
  const usedVideoPaths = new Set();

  function enrichLesson(lesson) {
    const videoRelative = lesson.videoFile || '';
    const videoAbsolute = videoRelative ? path.resolve(appDir, videoRelative) : '';
    let videoExists = false;
    let videoSizeBytes = 0;

    if (videoAbsolute && fs.existsSync(videoAbsolute)) {
      try {
        const stats = fs.statSync(videoAbsolute);
        videoExists = stats.isFile() && stats.size > 0;
        videoSizeBytes = stats.size;
        usedVideoPaths.add(videoRelative.replace(/\\/g, '/'));
      } catch {
        videoExists = false;
      }
    }

    const answerKey = Array.isArray(lesson.answerKey) ? lesson.answerKey : [];
    return {
      id: lesson.id,
      title: lesson.title || '',
      videoFile: videoRelative,
      videoExists,
      videoSizeBytes,
      caption: lesson.caption || '',
      introMessage: lesson.introMessage || '',
      taskMessage: lesson.taskMessage || '',
      answerKey,
      answerCount: answerKey.length
    };
  }

  const enrichedLessons = (gradeData.lessons || []).map(enrichLesson);
  const enrichedStandalone = (gradeData.standaloneLessons || []).map(enrichLesson);
  const collections = Object.entries(gradeData.collections || {}).map(([id, collection]) => ({
    id,
    title: collection.title || LESSON_COLLECTIONS[id]?.title || id,
    lessons: (Array.isArray(collection.lessons) ? collection.lessons : [])
      .map(lesson => ({ ...enrichLesson(lesson), collectionId: id }))
  }));

  const allConfiguredLessons = [
    ...enrichedLessons,
    ...enrichedStandalone,
    ...collections.flatMap(item => item.lessons)
  ];
  const availableVideos = diskVideos.map(video => ({
    ...video,
    isUsed: usedVideoPaths.has(video.relativePath) ||
      allConfiguredLessons.some(lesson =>
        lesson.videoFile.replace(/\\/g, '/') === video.relativePath)
  }));

  return {
    key: gradeKey,
    name: gradeData.name || gradeKey,
    keywords: Array.isArray(gradeData.keywords) ? gradeData.keywords : [],
    stageId: parsed.stageId,
    stageName: parsed.stageName,
    stageNameEn: parsed.stageNameEn,
    year: parsed.year,
    lessons: enrichedLessons,
    standaloneLessons: enrichedStandalone,
    collections,
    availableVideos
  };
}

export function saveLesson({
  gradeKey,
  lesson,
  isStandalone = false,
  collectionId = null,
  lessonsConfig = null,
  filePath = LESSONS_FILE
}) {
  if (!gradeKey || typeof gradeKey !== 'string') {
    throw new Error('A valid grade key is required.');
  }
  if (!lesson || typeof lesson !== 'object') {
    throw new Error('Lesson data object is required.');
  }

  const title = String(lesson.title || '').trim();
  if (!title) {
    throw new Error('Lesson title is required.');
  }

  const taskMessage = String(lesson.taskMessage || '').trim();
  if (!taskMessage) {
    throw new Error('Task exercise message (questions) is required.');
  }

  let answerKey = [];
  if (Array.isArray(lesson.answerKey)) {
    answerKey = lesson.answerKey.map(k => String(k || '').trim()).filter(Boolean);
  } else if (typeof lesson.answerKey === 'string') {
    answerKey = lesson.answerKey.split('\n').map(l => l.trim()).filter(Boolean);
  }
  if (answerKey.length === 0) {
    throw new Error('At least one correct answer key entry is required for automated evaluation.');
  }

  const videoFile = String(lesson.videoFile || '').trim();
  const caption = String(lesson.caption || '').trim();
  const introMessage = String(lesson.introMessage || '').trim();

  const config = lessonsConfig || readLessonsFile(filePath);
  if (!config[gradeKey]) {
    config[gradeKey] = {
      name: gradeKey,
      keywords: [gradeKey],
      lessons: []
    };
  }

  let lessonsList;
  if (collectionId) {
    const collection = LESSON_COLLECTIONS[collectionId];
    if (!collection || collection.gradeKey !== gradeKey) {
      throw new Error('This lesson collection is not available for the selected grade.');
    }
    config[gradeKey].collections ||= {};
    config[gradeKey].collections[collectionId] ||= {
      title: collection.title,
      lessons: []
    };
    lessonsList = config[gradeKey].collections[collectionId].lessons;
  } else {
    const targetArrayKey = isStandalone ? 'standaloneLessons' : 'lessons';
    if (!Array.isArray(config[gradeKey][targetArrayKey])) {
      config[gradeKey][targetArrayKey] = [];
    }
    lessonsList = config[gradeKey][targetArrayKey];
  }

  let lessonId = String(lesson.id || '').trim();
  if (!lessonId) {
    // Generate next lesson ID
    let maxNum = 0;
    for (const item of lessonsList) {
      const match = /^lesson_(\d+)$/.exec(item.id || '');
      if (match) {
        maxNum = Math.max(maxNum, Number(match[1]));
      }
    }
    lessonId = `lesson_${maxNum + 1}`;
  } else {
    // Sanitize ID
    lessonId = lessonId.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  const sanitizedLesson = {
    id: lessonId,
    title,
    videoFile,
    caption: caption || `🎬 فيديو ${title} | مستر مازن (eShool)`,
    introMessage: introMessage || `يا هلا بيك! دي الحصة: ${title}. برسل ليك الفيديو والتمرين هسي 👇`,
    taskMessage,
    answerKey
  };

  const existingIndex = lessonsList.findIndex(item => item.id === lessonId);
  if (existingIndex >= 0) {
    lessonsList[existingIndex] = sanitizedLesson;
  } else {
    lessonsList.push(sanitizedLesson);
  }

  writeLessonsFileAtomic(filePath, config);
  return { success: true, lesson: sanitizedLesson, isNew: existingIndex < 0 };
}

export function deleteLesson({
  gradeKey,
  lessonId,
  isStandalone = false,
  collectionId = null,
  lessonsConfig = null,
  filePath = LESSONS_FILE
}) {
  if (!gradeKey || !lessonId) {
    throw new Error('Grade key and lesson ID are required.');
  }

  const config = lessonsConfig || readLessonsFile(filePath);
  if (!config[gradeKey]) {
    throw new Error(`Grade "${gradeKey}" not found.`);
  }

  let list;
  if (collectionId) {
    const collection = LESSON_COLLECTIONS[collectionId];
    if (!collection || collection.gradeKey !== gradeKey) {
      throw new Error('This lesson collection is not available for the selected grade.');
    }
    list = config[gradeKey].collections?.[collectionId]?.lessons || [];
  } else {
    const targetArrayKey = isStandalone ? 'standaloneLessons' : 'lessons';
    list = config[gradeKey][targetArrayKey] || [];
  }
  const initialLength = list.length;
  const remaining = list.filter(item => item.id !== lessonId);

  if (remaining.length === initialLength) {
    throw new Error(`Lesson "${lessonId}" not found in grade "${gradeKey}".`);
  }
  if (collectionId) config[gradeKey].collections[collectionId].lessons = remaining;
  else config[gradeKey][isStandalone ? 'standaloneLessons' : 'lessons'] = remaining;

  writeLessonsFileAtomic(filePath, config);
  return { success: true, deletedId: lessonId };
}

export function reorderLessons({
  gradeKey,
  lessonIds,
  lessonsConfig = null,
  filePath = LESSONS_FILE
}) {
  if (!gradeKey || !Array.isArray(lessonIds)) {
    throw new Error('Grade key and an array of lesson IDs are required.');
  }

  const config = lessonsConfig || readLessonsFile(filePath);
  if (!config[gradeKey]) {
    throw new Error(`Grade "${gradeKey}" not found.`);
  }

  const currentLessons = config[gradeKey].lessons || [];
  const lessonMap = new Map(currentLessons.map(l => [l.id, l]));

  const reordered = [];
  for (const id of lessonIds) {
    if (lessonMap.has(id)) {
      reordered.push(lessonMap.get(id));
      lessonMap.delete(id);
    }
  }

  // Append any that were not mentioned in lessonIds
  for (const remaining of lessonMap.values()) {
    reordered.push(remaining);
  }

  config[gradeKey].lessons = reordered;
  writeLessonsFileAtomic(filePath, config);
  return { success: true, lessons: reordered };
}

export function saveGradeMetadata({
  gradeKey,
  name,
  keywords,
  lessonsConfig = null,
  filePath = LESSONS_FILE
}) {
  if (!gradeKey) throw new Error('A valid grade key is required.');

  const config = lessonsConfig || readLessonsFile(filePath);
  if (!config[gradeKey]) {
    config[gradeKey] = {
      name: name || gradeKey,
      keywords: Array.isArray(keywords) ? keywords : [gradeKey],
      lessons: []
    };
  } else {
    if (name && typeof name === 'string') config[gradeKey].name = name.trim();
    if (Array.isArray(keywords)) {
      config[gradeKey].keywords = keywords.map(k => String(k || '').trim()).filter(Boolean);
    }
  }

  writeLessonsFileAtomic(filePath, config);
  return { success: true, grade: config[gradeKey] };
}

export function saveLessonVideo({
  gradeKey,
  collectionId = null,
  fileName,
  buffer,
  mediaDir = LESSON_MEDIA_DIR
}) {
  if (!gradeKey || typeof gradeKey !== 'string') {
    throw new Error('Grade key is required for video upload.');
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Uploaded video file is empty.');
  }
  if (buffer.length > MAX_LESSON_VIDEO_BYTES) {
    throw new Error(`Video file exceeds the limit of ${Math.round(MAX_LESSON_VIDEO_BYTES / (1024 * 1024))} MB.`);
  }

  const safeFileName = sanitizeVideoFileName(fileName);
  if (collectionId &&
      (!LESSON_COLLECTIONS[collectionId] || LESSON_COLLECTIONS[collectionId].gradeKey !== gradeKey)) {
    throw new Error('This lesson collection is not available for the selected grade.');
  }
  const targetDir = collectionId
    ? path.join(mediaDir, gradeKey, collectionId)
    : path.join(mediaDir, gradeKey);
  fs.mkdirSync(targetDir, { recursive: true });

  const destinationPath = path.join(targetDir, safeFileName);
  fs.writeFileSync(destinationPath, buffer);

  return {
    success: true,
    fileName: safeFileName,
    relativePath: `media/lessons/${gradeKey}${collectionId ? `/${collectionId}` : ''}/${safeFileName}`,
    sizeBytes: buffer.length
  };
}
