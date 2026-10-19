import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  MAX_LESSON_VIDEO_BYTES,
  parseGradeStage,
  sanitizeVideoFileName,
  listCurriculumOverview,
  getGradeCurriculum,
  saveLesson,
  deleteLesson,
  reorderLessons,
  saveGradeMetadata,
  saveLessonVideo
} from './curriculum_manager.js';

test('parseGradeStage correctly extracts stage and year from grade keys', () => {
  const primary3 = parseGradeStage('grade_3_primary');
  assert.equal(primary3.stageId, 'primary');
  assert.equal(primary3.year, 3);
  assert.equal(primary3.stageName, 'المرحلة الابتدائية');

  const intermediate1 = parseGradeStage('grade_1_intermediate');
  assert.equal(intermediate1.stageId, 'intermediate');
  assert.equal(intermediate1.year, 1);

  const secondary3 = parseGradeStage('grade_3_secondary');
  assert.equal(secondary3.stageId, 'secondary');
  assert.equal(secondary3.year, 3);

  const unknown = parseGradeStage('custom_advanced');
  assert.equal(unknown.stageId, 'other');
  assert.equal(unknown.year, null);
});

test('sanitizeVideoFileName allows mp4/webm/mov and blocks dangerous/invalid names', () => {
  assert.equal(MAX_LESSON_VIDEO_BYTES, 300 * 1024 * 1024);
  assert.equal(sanitizeVideoFileName('lesson_1.mp4'), 'lesson_1.mp4');
  assert.equal(sanitizeVideoFileName('my lesson (intro).MP4'), 'my_lesson_(intro).MP4');
  assert.throws(() => sanitizeVideoFileName('script.exe'), /not supported/);
  assert.throws(() => sanitizeVideoFileName(''), /required/);
});

test('curriculum overview and grade details operate correctly on temporary test files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curriculum-test-'));
  const testLessonsFile = path.join(tmpDir, 'lessons.json');
  const testMediaDir = path.join(tmpDir, 'media', 'lessons');

  try {
    const initialConfig = {
      grade_1_primary: {
        name: 'الصف الأول ابتدائي',
        keywords: ['اولى ابتدائي'],
        lessons: []
      },
      grade_3_secondary: {
        name: 'الصف الثالث ثانوي',
        keywords: ['تالتة ثانوي'],
        lessons: [
          {
            id: 'lesson_1',
            title: 'Lesson 1',
            videoFile: 'media/lessons/grade_3_secondary/lesson_1.mp4',
            caption: 'Video 1',
            introMessage: 'Hello',
            taskMessage: '1. What is X?',
            answerKey: ['1. X is Y']
          }
        ]
      }
    };
    fs.writeFileSync(testLessonsFile, JSON.stringify(initialConfig, null, 2), 'utf8');

    // Create a dummy video file on disk
    const secDir = path.join(testMediaDir, 'grade_3_secondary');
    fs.mkdirSync(secDir, { recursive: true });
    fs.writeFileSync(path.join(secDir, 'lesson_1.mp4'), 'dummy-video-data');
    fs.writeFileSync(path.join(secDir, 'lesson_2_unassigned.mp4'), 'dummy-video-data-2');

    // Test listCurriculumOverview
    const overview = listCurriculumOverview(null, {
      filePath: testLessonsFile,
      mediaDir: testMediaDir
    });

    assert.equal(overview.totalLessons, 1);
    assert.equal(overview.gradesWithLessons, 1);
    assert.equal(overview.totalGrades, 2);

    const primaryStage = overview.stages.find(s => s.id === 'primary');
    assert.ok(primaryStage);
    assert.equal(primaryStage.grades.length, 1);
    assert.equal(primaryStage.grades[0].key, 'grade_1_primary');
    assert.equal(primaryStage.grades[0].totalLessons, 0);

    const secondaryStage = overview.stages.find(s => s.id === 'secondary');
    assert.ok(secondaryStage);
    const sec3 = secondaryStage.grades.find(g => g.key === 'grade_3_secondary');
    assert.ok(sec3);
    assert.equal(sec3.lessonCount, 1);
    assert.equal(sec3.diskVideoCount, 2);

    // Test getGradeCurriculum
    const details = getGradeCurriculum('grade_3_secondary', null, {
      filePath: testLessonsFile,
      mediaDir: testMediaDir,
      appDir: tmpDir
    });
    assert.equal(details.name, 'الصف الثالث ثانوي');
    assert.equal(details.lessons.length, 1);
    assert.equal(details.lessons[0].id, 'lesson_1');
    assert.equal(details.lessons[0].videoExists, true);
    assert.equal(details.availableVideos.length, 2);

    // Test saveLesson (add new lesson)
    const saveRes = saveLesson({
      gradeKey: 'grade_3_secondary',
      lesson: {
        title: 'Lesson 2: Past Simple',
        videoFile: 'media/lessons/grade_3_secondary/lesson_2.mp4',
        taskMessage: '1. Change to past tense.',
        answerKey: ['1. went']
      },
      filePath: testLessonsFile
    });
    assert.equal(saveRes.success, true);
    assert.equal(saveRes.lesson.id, 'lesson_2');

    // Check that it persisted
    const updatedDetails = getGradeCurriculum('grade_3_secondary', null, {
      filePath: testLessonsFile,
      mediaDir: testMediaDir,
      appDir: tmpDir
    });
    assert.equal(updatedDetails.lessons.length, 2);
    assert.equal(updatedDetails.lessons[1].title, 'Lesson 2: Past Simple');

    // Test reorderLessons
    reorderLessons({
      gradeKey: 'grade_3_secondary',
      lessonIds: ['lesson_2', 'lesson_1'],
      filePath: testLessonsFile
    });
    const reorderedDetails = getGradeCurriculum('grade_3_secondary', null, {
      filePath: testLessonsFile,
      mediaDir: testMediaDir,
      appDir: tmpDir
    });
    assert.equal(reorderedDetails.lessons[0].id, 'lesson_2');
    assert.equal(reorderedDetails.lessons[1].id, 'lesson_1');

    // Test deleteLesson
    const delRes = deleteLesson({
      gradeKey: 'grade_3_secondary',
      lessonId: 'lesson_2',
      filePath: testLessonsFile
    });
    assert.equal(delRes.success, true);
    const postDelDetails = getGradeCurriculum('grade_3_secondary', null, {
      filePath: testLessonsFile,
      mediaDir: testMediaDir,
      appDir: tmpDir
    });
    assert.equal(postDelDetails.lessons.length, 1);
    assert.equal(postDelDetails.lessons[0].id, 'lesson_1');

    // Test saveLessonVideo
    const videoUploadRes = saveLessonVideo({
      gradeKey: 'grade_1_primary',
      fileName: 'intro_primary.mp4',
      buffer: Buffer.from('simulated-mp4-stream'),
      mediaDir: testMediaDir
    });
    assert.equal(videoUploadRes.success, true);
    assert.equal(videoUploadRes.fileName, 'intro_primary.mp4');
    assert.equal(
      fs.existsSync(path.join(testMediaDir, 'grade_1_primary', 'intro_primary.mp4')),
      true
    );

    // Test saveGradeMetadata
    saveGradeMetadata({
      gradeKey: 'grade_1_primary',
      name: 'الصف الأول الابتدائي المطوّر',
      keywords: ['أولى ابتدائي', 'الصف الأول'],
      filePath: testLessonsFile
    });
    const primaryDetails = getGradeCurriculum('grade_1_primary', null, {
      filePath: testLessonsFile,
      mediaDir: testMediaDir,
      appDir: tmpDir
    });
    assert.equal(primaryDetails.name, 'الصف الأول الابتدائي المطوّر');
    assert.equal(primaryDetails.keywords.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Treasure Island lessons are managed in a separate Grade 3 Secondary collection', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'treasure-island-curriculum-'));
  const filePath = path.join(tmpDir, 'lessons.json');
  const mediaDir = path.join(tmpDir, 'media', 'lessons');
  fs.writeFileSync(filePath, JSON.stringify({
    grade_3_secondary: { name: 'Grade 3 Secondary', lessons: [] }
  }), 'utf8');

  try {
    const upload = saveLessonVideo({
      gradeKey: 'grade_3_secondary',
      collectionId: 'treasure_island',
      fileName: 'chapter_1.mp4',
      buffer: Buffer.from('video'),
      mediaDir
    });
    assert.equal(upload.relativePath, 'media/lessons/grade_3_secondary/treasure_island/chapter_1.mp4');

    const saved = saveLesson({
      gradeKey: 'grade_3_secondary',
      collectionId: 'treasure_island',
      lesson: {
        id: 'chapter_1',
        title: 'Chapter 1: The Old Sea-dog',
        videoFile: upload.relativePath,
        taskMessage: 'Answer the questions about Chapter 1.',
        answerKey: ['The old sea-dog is Billy Bones.']
      },
      filePath
    });
    assert.equal(saved.success, true);

    const details = getGradeCurriculum('grade_3_secondary', null, {
      filePath,
      mediaDir,
      appDir: tmpDir
    });
    assert.deepEqual(details.lessons, []);
    assert.equal(details.collections[0].id, 'treasure_island');
    assert.equal(details.collections[0].lessons[0].collectionId, 'treasure_island');
    assert.equal(details.collections[0].lessons[0].videoExists, true);
    assert.equal(details.availableVideos[0].isUsed, true);

    assert.throws(() => saveLesson({
      gradeKey: 'grade_2_secondary',
      collectionId: 'treasure_island',
      lesson: { title: 'Invalid', taskMessage: 'Exercise', answerKey: ['answer'] },
      filePath
    }), /not available for the selected grade/);

    deleteLesson({
      gradeKey: 'grade_3_secondary',
      collectionId: 'treasure_island',
      lessonId: 'chapter_1',
      filePath
    });
    assert.equal(getGradeCurriculum('grade_3_secondary', null, {
      filePath,
      mediaDir,
      appDir: tmpDir
    }).collections[0].lessons.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
