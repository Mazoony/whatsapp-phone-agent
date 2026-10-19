export function findLessonForMediaActivity(activity, lessonsConfig) {
  if (activity?.mediaType !== 'video' ||
      typeof activity.recipientJid !== 'string' ||
      !/^(?:\d+@s\.whatsapp\.net|[^@]+@lid)$/.test(activity.recipientJid) ||
      !lessonsConfig || typeof lessonsConfig !== 'object') {
    return null;
  }

  const lessons = [];
  for (const [gradeKey, grade] of Object.entries(lessonsConfig)) {
    const collections = [
      { lessons: grade?.lessons, collectionId: null },
      { lessons: grade?.standaloneLessons, collectionId: null },
      ...Object.entries(grade?.collections || {}).map(([collectionId, collection]) => ({
        lessons: collection?.lessons,
        collectionId
      }))
    ];
    for (const { lessons: lessonCollection, collectionId } of collections) {
      if (!Array.isArray(lessonCollection)) continue;
      for (const lesson of lessonCollection) {
        if (typeof lesson?.videoFile !== 'string' || !lesson.videoFile.trim()) continue;
        lessons.push({
          gradeKey,
          lessonId: lesson.id,
          ...(collectionId ? { collectionId } : {}),
          videoFile: lesson.videoFile,
          caption: lesson.caption || lesson.title || ''
        });
      }
    }
  }

  const retry = activity.retry;
  if (retry && typeof retry.gradeKey === 'string' && typeof retry.lessonId === 'string') {
    const exactLesson = lessons.find(lesson =>
      lesson.gradeKey === retry.gradeKey && lesson.lessonId === retry.lessonId &&
      (lesson.collectionId || null) === (retry.collectionId || null));
    if (exactLesson) return exactLesson;
  }

  const description = typeof activity.description === 'string' ? activity.description.trim() : '';
  if (!description) return null;
  const matches = lessons.filter(lesson =>
    description === lesson.caption || description === lesson.lessonId);
  const uniqueMatches = new Map(matches.map(lesson => [
    `${lesson.videoFile}\n${lesson.caption}\n${lesson.collectionId || ''}`,
    lesson
  ]));
  return uniqueMatches.size === 1 ? uniqueMatches.values().next().value : null;
}
