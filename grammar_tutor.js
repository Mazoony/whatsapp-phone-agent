import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPhoneJid } from './phonebook.js';
import { sendHumanizedMessage } from './humanization.js';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const GRAMMAR_TUTOR_PROGRESS_FILE = path.join(ROOT_DIR, 'data', 'grammar_tutor_progress.json');

function makeExercises(rows) {
  return rows.map(([before, cue, after, answer, explanation = 'Use the grammar rule explained above.']) => ({
    question_id: '',
    prompt: `${before}${before.includes('__________') || after.includes('__________') ? '' : '__________'}${after} *(${cue})*`,
    verb_or_word_cue: cue,
    accepted_answers: Array.isArray(answer) ? answer : [answer],
    explanation_for_answer: explanation
  })).map((exercise, index) => ({ ...exercise, question_id: String(index + 1) }));
}

function lesson(id, title, explanation, examples, rows, nextLessonId) {
  return {
    lesson_id: id,
    title,
    explanation,
    rules: [explanation],
    examples,
    exercises: makeExercises(rows),
    answer_key: makeExercises(rows).map((exercise, index) => ({
      question_id: String(index + 1),
      accepted_answers: exercise.accepted_answers,
      explanation_for_answer: exercise.explanation_for_answer
    })),
    next_lesson_id: nextLessonId
  };
}

const definitions = [
  lesson('present-s', 'Present Simple: Adding -s',
    'In the present simple, add -s to most verbs with he, she, it, or one person or thing.',
    ['I play football every day.', 'Ahmed plays football every day.', 'She reads every night.'], [
      ['Ahmed ', 'play', ' football every day.', 'plays'],
      ['Sara ', 'read', ' a story every night.', 'reads'],
      ['Ali ', 'eat', ' breakfast at seven every morning.', 'eats'],
      ['The baby ', 'drink', ' milk before bed every night.', 'drinks'],
      ['My father ', 'work', ' at the hospital every week.', 'works'],
      ['Fatima ', 'help', ' her sister with homework after school.', 'helps'],
      ['The teacher ', 'speak', ' English in class every day.', 'speaks'],
      ['Ahmed ', 'run', ' in the park every Friday.', 'runs'],
      ['My brother ', 'visit', ' our grandmother every weekend.', 'visits'],
      ['The bus ', 'stop', ' here every morning.', 'stops']
    ], 'present-es'),
  lesson('present-es', 'Present Simple: Adding -es',
    'For many verbs ending in -sh, -ch, -ss, -x, -z, or -o, add -es with he, she, it, or one person or thing.',
    ['She washes the dishes every evening.', 'He watches television at night.', 'Ali goes to school every morning.'], [
      ['Sara ', 'wash', ' the dishes every evening.', 'washes'],
      ['He ', 'watch', ' the news at night.', 'watches'],
      ['The teacher ', 'teach', ' English every morning.', 'teaches'],
      ['Ali ', 'finish', ' his homework before dinner every day.', 'finishes'],
      ['My sister ', 'go', ' to school by bus every weekday.', 'goes'],
      ['The student ', 'pass', ' the library on the way home every day.', 'passes'],
      ['Ahmed ', 'fix', ' his bicycle every Saturday.', 'fixes'],
      ['Fatima ', 'brush', ' her teeth after breakfast every morning.', 'brushes'],
      ['The train ', 'cross', ' the bridge at noon every day.', 'crosses'],
      ['The shop ', 'close', ' at nine every evening.', 'closes']
    ], 'present-consonant-y'),
  lesson('present-consonant-y', 'Present Simple: Consonant + Y',
    'When a verb ends in a consonant + y, change y to -ies with he, she, it, or one person or thing.',
    ['study → studies', 'cry → cries', 'carry → carries', 'tidy → tidies'], [
      ['Ahmed ', 'study', ' English every evening.', 'studies'],
      ['Sara ', 'carry', ' her books to school every day.', 'carries'],
      ['The baby ', 'cry', ' when it is hungry at night.', 'cries'],
      ['The teacher ', 'try', ' a new activity every week.', 'tries'],
      ['My brother ', 'tidy', ' his room every Saturday.', 'tidies'],
      ['Fatima ', 'worry', ' about her exams sometimes.', 'worries'],
      ['The student ', 'copy', ' the notes after class every day.', 'copies'],
      ['Ali ', 'reply', ' to his teacher every afternoon.', 'replies'],
      ['The bus ', 'carry', ' many students every morning.', 'carries'],
      ['Our school ', 'apply', ' the new rule every term.', 'applies']
    ], 'present-vowel-y'),
  lesson('present-vowel-y', 'Present Simple: Vowel + Y',
    'When a verb ends in a vowel + y, keep the y and add -s with he, she, it, or one person or thing.',
    ['play → plays', 'enjoy → enjoys', 'buy → buys', 'say → says'], [
      ['Ali ', 'play', ' football after school every day.', 'plays'],
      ['Sara ', 'enjoy', ' reading in the evening.', 'enjoys'],
      ['My father ', 'buy', ' fruit at the market every Friday.', 'buys'],
      ['The customer ', 'pay', ' for the bread every morning.', 'pays'],
      ['The teacher ', 'say', ' the new words slowly in class.', 'says'],
      ['Ahmed ', 'enjoy', ' English lessons every week.', 'enjoys'],
      ['My sister ', 'play', ' the piano at night.', 'plays'],
      ['The shop ', 'display', ' fresh food every day.', 'displays'],
      ['The child ', 'stay', ' with his aunt on Fridays.', 'stays'],
      ['The student ', 'obey', ' the classroom rules every day.', 'obeys']
    ], 'does-questions'),
  lesson('does-questions', 'Present Simple: Questions with Does',
    'Use Does + subject + base verb to ask about he, she, it, or one person or thing. After does, use the base verb.',
    ['Does Ahmed study English every day?', 'Does Sara go to school by bus?', 'Where does the teacher work?'], [
      ['__________ Ahmed ', 'study', ' English every evening? ', 'does study'],
      ['Where __________ Sara ', 'go', ' after school? ', 'does go'],
      ['When __________ the teacher ', 'start', ' the lesson? ', 'does start'],
      ['Why __________ Ali ', 'wake', ' up early every day? ', 'does wake'],
      ['How often __________ your sister ', 'visit', ' her grandmother? ', 'does visit'],
      ['__________ the bus ', 'stop', ' near your house every morning? ', 'does stop'],
      ['What __________ Fatima ', 'eat', ' for breakfast every day? ', 'does eat'],
      ['Where __________ your brother ', 'play', ' football on Fridays? ', 'does play'],
      ['__________ the shop ', 'close', ' at eight every evening? ', 'does close'],
      ['How often __________ Ahmed ', 'read', ' English books? ', 'does read']
    ], 'does-not'),
  lesson('does-not', 'Present Simple: Negative with Does Not',
    'Use subject + does not + base verb with he, she, it, and singular subjects. Never add -s to the verb after does not.',
    ['Ahmed does not play football on Mondays.', 'She does not watch television at night.', 'The shop does not open on Sundays.'], [
      ['Ahmed __________ __________ English every morning. ', 'not / study', '', 'does not study'],
      ['She __________ __________ television at night. ', 'not / watch', '', 'does not watch'],
      ['The shop __________ __________ on Fridays. ', 'not / open', '', 'does not open'],
      ['My brother __________ __________ coffee every day. ', 'not / drink', '', 'does not drink'],
      ['Sara __________ __________ late on school nights. ', 'not / sleep', '', 'does not sleep'],
      ['The teacher __________ __________ class late every morning. ', 'not / start', '', 'does not start'],
      ['Ali __________ __________ his homework at night. ', 'not / finish', '', 'does not finish'],
      ['The bus __________ __________ here on Sundays. ', 'not / stop', '', 'does not stop'],
      ['Fatima __________ __________ her books at home every day. ', 'not / leave', '', 'does not leave'],
      ['The baby __________ __________ outside in the afternoon. ', 'not / play', '', 'does not play']
    ], 'do-not'),
  lesson('do-not', 'Present Simple: Negative with Do Not',
    'Use subject + do not + base verb with I, you, we, they, and plural subjects.',
    ['I do not drink coffee every morning.', 'They do not play football on weekdays.', 'We do not go to school on Sundays.'], [
      ['We __________ __________ English after school every Friday. ', 'not / study', '', 'do not study'],
      ['I __________ __________ coffee in the morning. ', 'not / drink', '', 'do not drink'],
      ['They __________ __________ football on weekdays. ', 'not / play', '', 'do not play'],
      ['You __________ __________ your homework at night. ', 'not / finish', '', 'do not finish'],
      ['The students __________ __________ the bus every morning. ', 'not / miss', '', 'do not miss'],
      ['We __________ __________ television on school nights. ', 'not / watch', '', 'do not watch'],
      ['I __________ __________ late every day. ', 'not / arrive', '', 'do not arrive'],
      ['They __________ __________ to school on Sundays. ', 'not / go', '', 'do not go'],
      ['You __________ __________ your room every week. ', 'not / tidy', '', 'do not tidy'],
      ['The teachers __________ __________ meetings on Fridays. ', 'not / hold', '', 'do not hold']
    ], 'gerunds-1'),
  lesson('gerunds-1', 'Gerunds: Love, Hate, Like, Dislike, Enjoy, Prefer',
    'After love, hate, like, dislike, enjoy, or prefer, use a verb ending in -ing.',
    ['I enjoy reading books.', 'She likes learning English.', 'They prefer walking to school.'], [
      ['Ahmed enjoys __________ English every evening. ', 'practice', '', 'practicing'],
      ['Sara loves __________ stories at night. ', 'read', '', 'reading'],
      ['I like __________ football after school. ', 'play', '', 'playing'],
      ['They hate __________ early on Fridays. ', 'wake up', '', 'waking up'],
      ['We prefer __________ at home in the evening. ', 'study', '', 'studying'],
      ['Fatima dislikes __________ in long queues. ', 'wait', '', 'waiting'],
      ['My brother enjoys __________ to school every morning. ', 'walk', '', 'walking'],
      ['The students love __________ new words every week. ', 'learn', '', 'learning'],
      ['She prefers __________ tea after dinner. ', 'drink', '', 'drinking'],
      ['I hate __________ my homework late at night. ', 'do', '', 'doing']
    ], 'gerunds-2'),
  lesson('gerunds-2', 'Gerunds: Mind, Avoid, Finish, Keep, Practice',
    'Use a gerund (-ing form) after mind, avoid, finish, keep, and practice.',
    ['Would you mind opening the window?', 'He avoids making mistakes.', 'She finished doing her homework.'], [
      ['Do you mind __________ the door every evening? ', 'close', '', 'closing'],
      ['Sara avoids __________ mistakes in her writing. ', 'make', '', 'making'],
      ['Ali finishes __________ his homework before dinner. ', 'do', '', 'doing'],
      ['The teacher keeps __________ the rule every lesson. ', 'explain', '', 'explaining'],
      ['We practice __________ English every afternoon. ', 'speak', '', 'speaking'],
      ['Ahmed avoids __________ too much sugar at night. ', 'eat', '', 'eating'],
      ['They keep __________ the new words every week. ', 'review', '', 'reviewing'],
      ['Fatima finished __________ the classroom yesterday. ', 'clean', '', 'cleaning'],
      ['I practice __________ sentences in the morning. ', 'write', '', 'writing'],
      ['Would you mind __________ me after class? ', 'help', '', 'helping']
    ], 'gerunds-3'),
  lesson('gerunds-3', 'Gerunds: Suggest, Recommend, Consider, Admit, Deny',
    'Use a gerund after suggest, recommend, consider, admit, and deny.',
    ['They suggested taking a taxi.', 'I recommend reading every day.', 'He admitted making a mistake.'], [
      ['The teacher suggests __________ new words every day. ', 'review', '', 'reviewing'],
      ['I recommend __________ aloud every morning. ', 'read', '', 'reading'],
      ['Sara considers __________ a science club this term. ', 'join', '', 'joining'],
      ['Ahmed admitted __________ the wrong answer yesterday. ', 'write', '', 'writing'],
      ['They denied __________ the classroom window. ', 'break', '', 'breaking'],
      ['We suggest __________ the bus after school. ', 'take', '', 'taking'],
      ['The doctor recommends __________ more water every day. ', 'drink', '', 'drinking'],
      ['My sister is considering __________ a new language. ', 'learn', '', 'learning'],
      ['He admitted __________ late for class this morning. ', 'arrive', '', 'arriving'],
      ['The boys denied __________ during the lesson yesterday. ', 'talk', '', 'talking']
    ], 'gerunds-4'),
  lesson('gerunds-4', 'Gerunds: Imagine, Risk, Postpone, Delay, Quit',
    'Use a gerund after imagine, risk, postpone, delay, quit, and give up.',
    ['Imagine living near the sea.', 'They postponed meeting the teacher.', 'He gave up eating sweets.'], [
      ['Can you imagine __________ in a very cold place one day? ', 'live', '', 'living'],
      ['She risks __________ her bus if she leaves late. ', 'miss', '', 'missing'],
      ['We postponed __________ the school library until Monday. ', 'visit', '', 'visiting'],
      ['The rain delayed __________ the match yesterday. ', 'start', '', 'starting'],
      ['Ahmed quit __________ television before exams. ', 'watch', '', 'watching'],
      ['My brother gave up __________ fizzy drinks last month. ', 'drink', '', 'drinking'],
      ['They risk __________ the wrong road at night. ', 'take', '', 'taking'],
      ['I cannot imagine __________ without books. ', 'study', '', 'studying'],
      ['The school delayed __________ the new term by one week. ', 'begin', '', 'beginning'],
      ['Sara gave up __________ to bed late on weekdays. ', 'go', '', 'going']
    ], 'gerunds-5'),
  lesson('gerunds-5', 'Gerunds: Can’t Stand, Can’t Help, Feel Like, Miss, Appreciate',
    'Use a gerund after can’t stand, can’t help, feel like, miss, and appreciate.',
    ['I can’t stand waiting in long lines.', 'She feels like reading.', 'We appreciate your helping us.'], [
      ['I cannot stand __________ in noisy rooms at night. ', 'study', '', 'studying'],
      ['Sara cannot help __________ when she hears that song after school. ', 'smile', '', 'smiling'],
      ['Ahmed feels like __________ football after school. ', 'play', '', 'playing'],
      ['They miss __________ their cousins every weekend. ', 'visit', '', 'visiting'],
      ['We appreciate __________ us with the project this week. ', 'help', '', 'helping'],
      ['My brother cannot stand __________ early on Saturdays. ', 'wake up', '', 'waking up'],
      ['Fatima feels like __________ a story tonight. ', 'write', '', 'writing'],
      ['I miss __________ with my classmates after school. ', 'talk', '', 'talking'],
      ['The teacher appreciates __________ on time every day. ', 'arrive', '', 'arriving'],
      ['He cannot help __________ when his friend tells a joke. ', 'laugh', '', 'laughing']
    ], 'gerunds-6'),
  lesson('gerunds-6', 'Gerunds: Common Expressions',
    'Use a gerund after expressions such as interested in, good at, look forward to, be used to, how about, worth, and have difficulty. In look forward to and be used to, to is a preposition.',
    ['She is interested in learning English.', 'I look forward to meeting you.', 'He is used to waking up early.'], [
      ['Sara is interested in __________ new languages this year. ', 'learn', '', 'learning'],
      ['Ahmed is good at __________ football every Friday. ', 'play', '', 'playing'],
      ['We look forward to __________ you tomorrow. ', 'see', '', 'seeing'],
      ['She is used to __________ up early every morning. ', 'wake', '', 'waking'],
      ['How about __________ to the library after school? ', 'go', '', 'going'],
      ['This book is worth __________ every week. ', 'read', '', 'reading'],
      ['I have difficulty __________ long English words every day. ', 'spell', '', 'spelling'],
      ['They spend time __________ English every evening. ', 'practice', '', 'practicing'],
      ['Do not waste time __________ about small mistakes. ', 'worry', '', 'worrying'],
      ['What about __________ our homework together tonight? ', 'do', '', 'doing']
    ], 'make-active'),
  lesson('make-active', 'Make + Object + Base Verb: Active',
    'In active sentences, use make + person or thing + base verb, without to.',
    ['The teacher makes us study hard.', 'The film made everyone laugh.', 'The joke will make Ali smile.'], [
      ['The teacher made the students __________ the exercise again. ', 'do', '', 'do'],
      ['The coach makes Ahmed __________ after school every day. ', 'run', '', 'run'],
      ['The joke made Sara __________ yesterday. ', 'laugh', '', 'laugh'],
      ['The story makes the children __________ every evening. ', 'smile', '', 'smile'],
      ['The teacher will make us __________ the new words tomorrow. ', 'repeat', '', 'repeat'],
      ['The noise made the baby __________ at night. ', 'wake up', '', 'wake up'],
      ['My parents make me __________ my room every Saturday. ', 'clean', '', 'clean'],
      ['The exciting game made everyone __________ loudly. ', 'cheer', '', 'cheer'],
      ['The teacher can make the class __________ quietly. ', 'work', '', 'work'],
      ['The film made my brother __________ about his future. ', 'think', '', 'think']
    ], 'make-tenses'),
  lesson('make-tenses', 'Make: Tense Variations',
    'The verb make changes with tense or a modal, but the verb after the object stays in its base form.',
    ['She makes me laugh.', 'She is making me rewrite it.', 'She has made me finish it.', 'She will make me try again.'], [
      ['The teacher __________ us __________ the task every day. ', 'make / complete', '', 'makes complete'],
      ['The coach is __________ Ali __________ around the field now. ', 'make / run', '', 'making run'],
      ['My parents __________ me __________ my homework yesterday. ', 'make / finish', '', 'made finish'],
      ['The teacher has __________ Sara __________ the sentence again. ', 'make / write', '', 'made write'],
      ['The film will __________ everyone __________ tomorrow. ', 'make / smile', '', 'make smile'],
      ['The rules can __________ students __________ more carefully. ', 'make / work', '', 'make work'],
      ['The noise __________ the baby __________ last night. ', 'make / wake', '', 'made wake'],
      ['The teacher is __________ the students __________ the answer now. ', 'make / check', '', 'making check'],
      ['This story has __________ me __________ about my choices. ', 'make / think', '', 'made think'],
      ['The game might __________ them __________ after school. ', 'make / stay', '', 'make stay']
    ], 'make-passive'),
  lesson('make-passive', 'Make: Passive Voice',
    'In the passive, use be made + to + base verb. Unlike active make, passive make needs to.',
    ['Active: The teacher made him apologize.', 'Passive: He was made to apologize.'], [
      ['Ahmed was made __________ the exercise again. ', 'to / do', '', 'to do'],
      ['Sara is made __________ the rule aloud every morning. ', 'to / read', '', 'to read'],
      ['The students were made __________ the classroom yesterday. ', 'to / clean', '', 'to clean'],
      ['Ali has been made __________ his answer. ', 'to / explain', '', 'to explain'],
      ['The players will be made __________ after the match. ', 'to / run', '', 'to run'],
      ['The child was made __________ sorry last night. ', 'to / say', '', 'to say'],
      ['We are made __________ our phones away during class. ', 'to / put', '', 'to put'],
      ['The workers were made __________ the wall again. ', 'to / paint', '', 'to paint'],
      ['Fatima has been made __________ the form carefully. ', 'to / complete', '', 'to complete'],
      ['The team may be made __________ the game again. ', 'to / play', '', 'to play']
    ], 'let-active'),
  lesson('let-active', 'Let + Object + Base Verb: Active',
    'In active sentences, use let + person + base verb, without to.',
    ['My parents let me play outside.', 'The teacher lets us use dictionaries.', 'They let the children leave early.'], [
      ['My parents let me __________ outside after school. ', 'play', '', 'play'],
      ['The teacher lets us __________ dictionaries in class. ', 'use', '', 'use'],
      ['They let the children __________ early yesterday. ', 'leave', '', 'leave'],
      ['Sara lets her brother __________ her books. ', 'borrow', '', 'borrow'],
      ['Our coach lets the players __________ water every hour. ', 'drink', '', 'drink'],
      ['The guard let Ahmed __________ the building last night. ', 'enter', '', 'enter'],
      ['My mother lets me __________ television after homework. ', 'watch', '', 'watch'],
      ['The teacher let Fatima __________ her answer. ', 'correct', '', 'correct'],
      ['The school lets students __________ the library after class. ', 'visit', '', 'visit'],
      ['His parents let him __________ the trip next week. ', 'join', '', 'join']
    ], 'let-tenses'),
  lesson('let-tenses', 'Let: Tense Variations',
    'Let can change with tense or a modal. The verb after the person stays in its base form.',
    ['My parents let me go out.', 'They are letting us use the room.', 'She has let him travel.', 'We will let you choose.'], [
      ['My parents __________ me __________ out every weekend. ', 'let', ' go', 'let go'],
      ['They are __________ us __________ the room now. ', 'let', ' use', 'letting use'],
      ['The teacher __________ Ali __________ late yesterday. ', 'let', ' stay', 'let stay'],
      ['My parents have __________ me __________ alone. ', 'let', ' travel', 'let travel'],
      ['The school will __________ students __________ the library tomorrow. ', 'let', ' use', 'let use'],
      ['Her mother might __________ Sara __________ the game. ', 'let', ' watch', 'let watch'],
      ['The coach is __________ the team __________ early today. ', 'let', ' leave', 'letting leave'],
      ['They have __________ us __________ our own groups. ', 'let', ' choose', 'let choose'],
      ['The guard __________ the visitors __________ the room last night. ', 'let', ' enter', 'let enter'],
      ['My father will __________ me __________ his bicycle. ', 'let', ' borrow', 'let borrow']
    ], 'let-passive'),
  lesson('let-passive', 'Let: Passive with Be Allowed To',
    'In passive sentences, let is usually replaced by be allowed to + base verb.',
    ['Active: They let him leave early.', 'Passive: He was allowed to leave early.'], [
      ['Sara was allowed __________ the library after school. ', 'to / use', '', 'to use'],
      ['We are allowed __________ our dictionaries in class. ', 'to / use', '', 'to use'],
      ['Ahmed has been allowed __________ the school team. ', 'to / join', '', 'to join'],
      ['The children were allowed __________ outside yesterday. ', 'to / play', '', 'to play'],
      ['Students will be allowed __________ the new laboratory tomorrow. ', 'to / visit', '', 'to visit'],
      ['Ali is allowed __________ home by bus every day. ', 'to / travel', '', 'to travel'],
      ['Fatima was allowed __________ her answer after class. ', 'to / change', '', 'to change'],
      ['The team may be allowed __________ early today. ', 'to / leave', '', 'to leave'],
      ['I have been allowed __________ the project at home. ', 'to / complete', '', 'to complete'],
      ['The visitors were allowed __________ the museum last Friday. ', 'to / enter', '', 'to enter']
    ], 'mixed-review'),
  lesson('mixed-review', 'Mixed Review: Grammar Course',
    'This final review mixes the rules you have studied: present-simple spelling, questions and negatives, gerunds, make, and let. Identify the rule needed in each sentence.',
    ['She studies every day.', 'Does he play football?', 'They enjoy reading.', 'The teacher made us work.', 'My parents let me go.'], [
      ['Ahmed __________ English every morning. ', 'study', '', 'studies'],
      ['The shop __________ at nine every evening. ', 'close', '', 'closes'],
      ['Sara __________ her books to school every day. ', 'carry', '', 'carries'],
      ['__________ Ali __________ football after school? ', 'does / play', '', 'does play'],
      ['We __________ __________ television on school nights. ', 'not / watch', '', 'do not watch'],
      ['Fatima __________ __________ late every day. ', 'not / arrive', '', 'does not arrive'],
      ['He enjoys __________ stories every evening. ', 'read', '', 'reading'],
      ['The teacher made us __________ the task again. ', 'do', '', 'do'],
      ['My parents let me __________ with my friends. ', 'play', '', 'play'],
      ['She is interested in __________ English this year. ', 'learn', '', 'learning']
    ], null)
];

export const GRAMMAR_CURRICULUM = Object.fromEntries(
  definitions.map((definition, index) => {
    const nextLessonId = definitions[index + 1]?.lesson_id || null;
    return [definition.lesson_id, { ...definition, next_lesson_id: nextLessonId }];
  })
);

const LESSON_SEQUENCE = definitions.map(item => item.lesson_id);

function normalizeAnswer(value) {
  return value
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseNumberedAnswers(text, questionCount = 10) {
  if (typeof text !== 'string') return { answers: {}, invalidNumbers: [] };
  const marker = /(?:^|\s)(\d{1,2})\s*[).:\-]\s*/g;
  const matches = [...text.matchAll(marker)];
  if (!matches.length) return { answers: {}, invalidNumbers: [] };

  const answers = {};
  const invalidNumbers = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const number = Number(match[1]);
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : text.length;
    const answer = text.slice(start, end).trim().replace(/[,;]+$/, '').trim();
    if (number < 1 || number > questionCount || !answer || answers[number]) {
      invalidNumbers.push(number);
      continue;
    }
    answers[number] = answer;
  }
  return { answers, invalidNumbers };
}

function answerIsCorrect(exercise, answer) {
  const actual = normalizeAnswer(answer);
  return exercise.accepted_answers.some(expected => {
    const normalizedExpected = normalizeAnswer(expected);
    return actual === normalizedExpected ||
      new RegExp(`(?:^| )${normalizedExpected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$| )`).test(actual);
  });
}

export function isGrammarCourseStartRequest(text) {
  if (typeof text !== 'string') return false;
  const normalized = text.replace(/[أإآٱ]/g, 'ا');
  return (
    /\b(?:start|begin|take)\b.{0,30}\b(?:english\s+)?grammar\s+(?:course|lessons?|tutor)\b/i.test(normalized) ||
    /\b(?:grammar\s+(?:course|lessons?|tutor)|english\s+grammar\s+(?:course|lessons?))\b/i.test(normalized) ||
    /(?:ابدا|ابدء|عايز|عاوز|داير).{0,30}(?:قواعد\s+الانجليزي(?:ة)?|جرامر)/i.test(normalized)
  );
}

export function isGrammarCourseControlRequest(text) {
  return typeof text === 'string' && (
    isGrammarCourseStartRequest(text) ||
    /\b(?:repeat|restart|again|explain|explanation|rule|retry|try again|next|review|mixed test)\b/i.test(text) ||
    /اعد|كرر|عيد|اشرح|القاعدة|اعيد|حاول تاني|الدرس التالي|الحصة الجاية|راجع|اختبار مختلط/i.test(text)
  );
}

export class GrammarTutor {
  constructor({
    progressFile = GRAMMAR_TUTOR_PROGRESS_FILE,
    sendText = sendHumanizedMessage
  } = {}) {
    this.progressFile = progressFile;
    this.sendText = sendText;
    this.progress = this.loadProgress();
  }

  loadProgress() {
    if (!fs.existsSync(this.progressFile)) return {};
    try {
      const progress = JSON.parse(fs.readFileSync(this.progressFile, 'utf8'));
      if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
        throw new Error('Grammar tutor progress must be a JSON object.');
      }
      return progress;
    } catch (error) {
      console.error('[Grammar Tutor] Could not load saved progress:', error.message);
      throw error;
    }
  }

  saveProgress() {
    const directory = path.dirname(this.progressFile);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = `${this.progressFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(this.progress, null, 2), 'utf8');
      fs.renameSync(temporaryPath, this.progressFile);
    } catch (error) {
      try {
        fs.rmSync(temporaryPath, { force: true });
      } catch (cleanupError) {
        console.error('[Grammar Tutor] Could not clean temporary progress file:', cleanupError.message);
      }
      console.error('[Grammar Tutor] Could not save progress:', error.message);
      throw error;
    }
  }

  keyFor(jid, linkedPhoneJid = null) {
    return getPhoneJid(linkedPhoneJid, jid) || jid;
  }

  getStudent(jid, linkedPhoneJid = null) {
    return this.progress[this.keyFor(jid, linkedPhoneJid)] || null;
  }

  getCurrentLesson(jid, linkedPhoneJid = null) {
    const student = this.getStudent(jid, linkedPhoneJid);
    return student ? GRAMMAR_CURRICULUM[student.currentLessonId] || null : null;
  }

  isActive(jid, linkedPhoneJid = null) {
    const student = this.getStudent(jid, linkedPhoneJid);
    return Boolean(student && ['awaiting_grade', 'awaiting_answers', 'awaiting_retry'].includes(student.status));
  }

  async send(sock, jid, text) {
    await this.sendText(sock, jid, text);
  }

  async sendLesson(sock, jid, student) {
    const current = GRAMMAR_CURRICULUM[student.currentLessonId];
    if (!current) throw new Error(`Unknown grammar lesson: ${student.currentLessonId}`);

    const examples = current.examples.map(example => `• ${example}`).join('\n');
    const explanation = `📘 *${current.title}*\n\n${current.explanation}\n\n*Examples:*\n${examples}`;
    const exercises = current.exercises.map(item =>
      `${item.question_id}. ${item.prompt}`).join('\n');
    const task = `📝 *Practice — 10 questions*\n\nComplete each sentence. Write the correct answer for each numbered blank. Send your answers numbered 1–10.\n\n${exercises}`;

    await this.send(sock, jid, explanation);
    await this.send(sock, jid, task);
    student.status = 'awaiting_answers';
    student.answers = {};
    student.incorrectQuestionIds = [];
    student.currentScore = 0;
    student.correctQuestionIds = [];
    student.lessonSentAt = new Date().toISOString();
    this.saveProgress();
  }

  async start(sock, jid, gradeKey, linkedPhoneJid = null) {
    const key = this.keyFor(jid, linkedPhoneJid);
    if (!/^grade_[123]_secondary$/.test(gradeKey || '')) {
      this.progress[key] = {
        ...(this.progress[key] || {}),
        status: 'awaiting_grade',
        completedLessonIds: this.progress[key]?.completedLessonIds || []
      };
      this.saveProgress();
      await this.send(sock, jid, 'I can start the grammar course for secondary students. Which grade are you in: first, second, or third secondary?');
      return true;
    }

    const previous = this.progress[key];
    if (previous && previous.gradeKey !== gradeKey) {
      await this.send(sock, jid, 'I have a grammar course saved for a different grade. Please ask your teacher before changing the course grade.');
      return true;
    }

    const completedLessonIds = previous?.completedLessonIds || [];
    const firstIncomplete = LESSON_SEQUENCE.find(id => !completedLessonIds.includes(id));
    if (!firstIncomplete) {
      this.progress[key] = { ...previous, gradeKey, status: 'completed', completedLessonIds };
      this.saveProgress();
      await this.send(sock, jid, 'You have completed the full grammar course, including the mixed review. Excellent work! Ask me to review any concept you would like to practice again.');
      return true;
    }

    const student = {
      ...previous,
      gradeKey,
      currentLessonId: previous?.currentLessonId || firstIncomplete,
      completedLessonIds,
      answers: previous?.answers || {},
      incorrectQuestionIds: previous?.incorrectQuestionIds || []
    };
    this.progress[key] = student;
    await this.sendLesson(sock, jid, student);
    return true;
  }

  async handleMessage(sock, jid, text, gradeKey = null, linkedPhoneJid = null) {
    const key = this.keyFor(jid, linkedPhoneJid);
    let student = this.progress[key];
    if (!student && !isGrammarCourseStartRequest(text)) return false;
    if (!student) return this.start(sock, jid, gradeKey, linkedPhoneJid);

    if (student.status === 'awaiting_grade') {
      if (!/^grade_[123]_secondary$/.test(gradeKey || '')) {
        await this.send(sock, jid, 'Please tell me your grade in secondary school: first, second, or third.');
        return true;
      }
      delete this.progress[key];
      return this.start(sock, jid, gradeKey, linkedPhoneJid);
    }

    if (isGrammarCourseStartRequest(text)) {
      return this.start(sock, jid, gradeKey || student.gradeKey, linkedPhoneJid);
    }

    const normalizedText = text
      .toLowerCase()
      .replace(/[أإآٱ]/g, 'ا')
      .replace(/[?!.,،؛]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (/\b(?:review|completed concepts)\b|راجع|المفاهيم السابقة/i.test(normalizedText)) {
      const completed = student.completedLessonIds
        .map(id => GRAMMAR_CURRICULUM[id]?.title)
        .filter(Boolean);
      await this.send(sock, jid, completed.length
        ? `You have completed these concepts:\n${completed.map(title => `• ${title}`).join('\n')}`
        : 'You have not completed a grammar concept yet. Continue with the current exercise first.');
      return true;
    }
    if (/\b(?:mixed test|mixed review)\b|اختبار مختلط/i.test(normalizedText)) {
      const requiredLessons = LESSON_SEQUENCE.filter(id => id !== 'mixed-review');
      if (!requiredLessons.every(id => student.completedLessonIds.includes(id))) {
        await this.send(sock, jid, 'Complete the individual grammar concepts first. The mixed review comes at the end of the course.');
        return true;
      }
      student.currentLessonId = 'mixed-review';
      student.answers = {};
      student.incorrectQuestionIds = [];
      await this.sendLesson(sock, jid, student);
      return true;
    }
    if (/\b(?:repeat|restart|again)\b|اعد|كرر|عيد/i.test(normalizedText)) {
      student.answers = {};
      student.incorrectQuestionIds = [];
      await this.sendLesson(sock, jid, student);
      return true;
    }
    if (/\b(?:explain|explanation|rule)\b|اشرح|القاعدة/i.test(normalizedText)) {
      const current = GRAMMAR_CURRICULUM[student.currentLessonId];
      const examples = current.examples.map(example => `• ${example}`).join('\n');
      await this.send(sock, jid, `📘 *${current.title}*\n\n${current.explanation}\n\n*Examples:*\n${examples}`);
      return true;
    }
    if (/\b(?:retry|try again)\b|اعيد|حاول تاني/i.test(normalizedText)) {
      if (student.incorrectQuestionIds.length) {
        student.status = 'awaiting_retry';
        this.saveProgress();
        await this.send(sock, jid, `Please retry these questions: ${student.incorrectQuestionIds.join(', ')}. Send only the corrected answers, numbered.`);
      } else {
        await this.send(sock, jid, 'There are no incorrect answers to retry right now. Send your numbered answers when you are ready.');
      }
      return true;
    }
    if (/\b(?:next|next lesson)\b|الدرس التالي|الحصة الجاية/i.test(normalizedText)) {
      await this.send(sock, jid, 'Complete the current 10-question exercise first. I will continue to the next concept after all answers are correct.');
      return true;
    }

    const current = GRAMMAR_CURRICULUM[student.currentLessonId];
    if (!current) throw new Error(`Unknown saved grammar lesson: ${student.currentLessonId}`);
    const parsed = parseNumberedAnswers(text, current.exercises.length);
    if (parsed.invalidNumbers.length) {
      await this.send(sock, jid, `I could not match question number${parsed.invalidNumbers.length > 1 ? 's' : ''} ${parsed.invalidNumbers.join(', ')}. Please send answers numbered 1–10.`);
      return true;
    }
    if (!Object.keys(parsed.answers).length) {
      if (/\d/.test(text) || /\b(?:answer|answers|my answers)\b/i.test(text)) {
        await this.send(sock, jid, 'I could not match your answers to the questions. Please write them with question numbers, for example: 1. studies');
        return true;
      }
      if (/[?؟]/.test(text) ||
          /\b(?:hello|hi|hey|fee|fees|price|payment|help me|how are you)\b|مرحبا|السلام|كيف حالك|الرسوم|السعر|دفع/i.test(text)) {
        return false;
      }
      await this.send(sock, jid, 'I could not match that to a numbered answer. Please send answers with question numbers, for example: 1. studies');
      return true;
    }

    for (const [number, answer] of Object.entries(parsed.answers)) {
      student.answers[number] = answer;
    }
    const results = Object.entries(parsed.answers).map(([number, answer]) => {
      const exercise = current.exercises[Number(number) - 1];
      const correct = answerIsCorrect(exercise, answer);
      if (!correct && !student.incorrectQuestionIds.includes(Number(number))) {
        student.incorrectQuestionIds.push(Number(number));
      }
      if (correct) {
        student.incorrectQuestionIds = student.incorrectQuestionIds.filter(id => id !== Number(number));
      }
      return { number, answer, exercise, correct };
    });

    const score = Object.entries(student.answers).filter(([number, answer]) =>
      answerIsCorrect(current.exercises[Number(number) - 1], answer)).length;
    student.currentScore = score;
    student.correctQuestionIds = Object.entries(student.answers)
      .filter(([number, answer]) => answerIsCorrect(current.exercises[Number(number) - 1], answer))
      .map(([number]) => Number(number));
    student.conceptsNeedingRevision ||= [];
    if (student.incorrectQuestionIds.length &&
        !student.conceptsNeedingRevision.includes(student.currentLessonId)) {
      student.conceptsNeedingRevision.push(student.currentLessonId);
    }
    let feedback = results.map(result => result.correct
      ? `${result.number}. ✅ Correct.`
      : `${result.number}. ❌ The correct answer is *${result.exercise.accepted_answers[0]}*. ${result.exercise.explanation_for_answer}`
    ).join('\n');
    const unansweredIds = current.exercises
      .map(item => Number(item.question_id))
      .filter(number => !student.answers[number]);

    if (unansweredIds.length) {
      student.status = 'awaiting_answers';
      this.saveProgress();
      feedback += `\n\nYou have answered ${Object.keys(student.answers).length}/10. Please complete: ${unansweredIds.join(', ')}.`;
      await this.send(sock, jid, feedback);
      return true;
    }

    if (student.incorrectQuestionIds.length) {
      student.status = 'awaiting_retry';
      this.saveProgress();
      const reviewedIncorrectIds = new Set(results
        .filter(result => !result.correct)
        .map(result => Number(result.number)));
      const previousMistakes = student.incorrectQuestionIds
        .filter(number => !reviewedIncorrectIds.has(number))
        .map(number => {
          const exercise = current.exercises[number - 1];
          return `${number}. ❌ The correct answer is *${exercise.accepted_answers[0]}*. ${exercise.explanation_for_answer}`;
        });
      if (previousMistakes.length) feedback += `\n${previousMistakes.join('\n')}`;
      feedback += `\n\n*Score: ${score}/10.* Please retry the incorrect questions: ${student.incorrectQuestionIds.join(', ')}. Send corrected answers with their question numbers.`;
      await this.send(sock, jid, feedback);
      return true;
    }

    student.completedLessonIds = [...new Set([...student.completedLessonIds, student.currentLessonId])];
    student.conceptsNeedingRevision = student.conceptsNeedingRevision
      .filter(lessonId => lessonId !== student.currentLessonId);
    student.currentScore = 10;
    student.correctQuestionIds = current.exercises.map(item => Number(item.question_id));
    const nextLessonId = current.next_lesson_id;
    if (!nextLessonId) {
      student.status = 'completed';
      this.saveProgress();
      await this.send(sock, jid, `🌟 *Score: 10/10.* You have completed the full grammar course, including the mixed review. Excellent work!`);
      return true;
    }

    student.currentLessonId = nextLessonId;
    student.answers = {};
    student.incorrectQuestionIds = [];
    student.status = 'awaiting_answers';
    this.saveProgress();
    await this.send(sock, jid, `🌟 *Score: 10/10.* Excellent work! You have completed *${current.title}*. Here is the next concept.`);
    await this.sendLesson(sock, jid, student);
    return true;
  }
}

export const grammarTutor = new GrammarTutor();
