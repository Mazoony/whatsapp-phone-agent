import assert from 'node:assert/strict';
import test from 'node:test';
import { findLessonForMediaActivity } from './lesson_media_retry.js';

const lessonsConfig = {
  grade_3_secondary: {
    lessons: [{
      id: 'lesson_1',
      title: 'Lesson One',
      videoFile: 'media/lesson_1.mp4',
      caption: 'Watch Lesson One'
    }]
  }
};

test('finds a failed lesson video by its saved retry metadata', () => {
  assert.deepEqual(findLessonForMediaActivity({
    mediaType: 'video',
    recipientJid: '1001@s.whatsapp.net',
    retry: { gradeKey: 'grade_3_secondary', lessonId: 'lesson_1' }
  }, lessonsConfig), {
    gradeKey: 'grade_3_secondary',
    lessonId: 'lesson_1',
    videoFile: 'media/lesson_1.mp4',
    caption: 'Watch Lesson One'
  });
});

test('identifies earlier failed activities by exact lesson caption', () => {
  assert.equal(findLessonForMediaActivity({
    mediaType: 'video',
    recipientJid: '1001@lid',
    description: 'Watch Lesson One'
  }, lessonsConfig)?.lessonId, 'lesson_1');
});

test('finds Treasure Island retry activities by collection identity', () => {
  const config = {
    grade_3_secondary: {
      lessons: [{
        id: 'chapter_1',
        title: 'Regular chapter',
        videoFile: 'media/regular.mp4',
        caption: 'Chapter video'
      }],
      collections: {
        treasure_island: {
          lessons: [{
            id: 'chapter_1',
            title: 'Treasure Island Chapter One',
            videoFile: 'media/treasure_island/chapter_1.mp4',
            caption: 'Chapter video'
          }]
        }
      }
    }
  };
  assert.deepEqual(findLessonForMediaActivity({
    mediaType: 'video',
    recipientJid: '1001@s.whatsapp.net',
    retry: {
      gradeKey: 'grade_3_secondary',
      lessonId: 'chapter_1',
      collectionId: 'treasure_island'
    }
  }, config), {
    gradeKey: 'grade_3_secondary',
    lessonId: 'chapter_1',
    collectionId: 'treasure_island',
    videoFile: 'media/treasure_island/chapter_1.mp4',
    caption: 'Chapter video'
  });
});

test('does not offer retries for unsupported media or ambiguous lesson captions', () => {
  const duplicateConfig = {
    ...lessonsConfig,
    grade_4: {
      lessons: [{
        id: 'lesson_1',
        title: 'Other lesson',
        videoFile: 'media/other.mp4',
        caption: 'Watch Lesson One'
      }]
    }
  };

  assert.equal(findLessonForMediaActivity({
    mediaType: 'audio',
    recipientJid: '1001@s.whatsapp.net',
    description: 'Watch Lesson One'
  }, lessonsConfig), null);
  assert.equal(findLessonForMediaActivity({
    mediaType: 'video',
    recipientJid: 'newsletter@newsletter',
    description: 'Watch Lesson One'
  }, lessonsConfig), null);
  assert.equal(findLessonForMediaActivity({
    mediaType: 'video',
    recipientJid: '1001@s.whatsapp.net',
    description: 'Watch Lesson One'
  }, duplicateConfig), null);
});
