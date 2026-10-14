import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { historyManager } from './history.js';
import { generateClientResponse } from './ai.js';
import { lessonManager } from './lesson_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const WEB_STUDENT_JID = 'web_student@s.whatsapp.net';
const WEB_STUDENT_NAME = 'طالب تجريبي (Es Student)';

// Register as an Es contact for permanent memory in the browser
historyManager.saveContact(WEB_STUDENT_JID, WEB_STUDENT_NAME);

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS & UTF-8
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // 1. Serve index.html
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    const htmlPath = path.join(__dirname, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // 2. GET /api/history
  if (req.method === 'GET' && req.url === '/api/history') {
    const list = historyManager.history[WEB_STUDENT_JID] || [];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ history: list }));
    return;
  }

  // 3. POST /api/reset
  if (req.method === 'POST' && req.url === '/api/reset') {
    historyManager.history[WEB_STUDENT_JID] = [];
    if (lessonManager.progress[WEB_STUDENT_JID]) {
      delete lessonManager.progress[WEB_STUDENT_JID];
      lessonManager.saveProgress();
    }
    historyManager.scheduleSave();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 4. POST /api/chat
  if (req.method === 'POST' && req.url === '/api/chat') {
    try {
      const { message } = await parseJsonBody(req);
      const text = (message || '').trim();

      if (!text) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message text is required' }));
        return;
      }

      // Add to history
      historyManager.addMessage(WEB_STUDENT_JID, 'client', text, Date.now(), WEB_STUDENT_NAME);

      // A. Check if student submitted homework
      if (lessonManager.hasActiveLesson(WEB_STUDENT_JID)) {
        let feedbackSent = null;
        const mockSock = {
          async sendMessage(jid, content) {
            if (content.text) feedbackSent = content.text;
          }
        };

        const handled = await lessonManager.handleTaskSubmission(mockSock, WEB_STUDENT_JID, text, WEB_STUDENT_NAME);
        if (handled && feedbackSent) {
          historyManager.addMessage(WEB_STUDENT_JID, 'agent', feedbackSent, Date.now());
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ reply: feedbackSent, type: 'task_feedback' }));
          return;
        }
      }

      // B. Check if grade was mentioned
      const detectedGrade = lessonManager.detectGrade(text);
      const student = lessonManager.getStudent(WEB_STUDENT_JID);

      if (detectedGrade && !student) {
        let introText = '';
        let taskText = '';
        const gradeData = lessonManager.lessonsConfig[detectedGrade];
        const lesson = gradeData?.lessons?.[0];

        const mockSock = {
          async sendMessage(jid, content) {
            if (content.text) {
              if (!introText) introText = content.text;
              else taskText = content.text;
            }
          }
        };

        await lessonManager.deliverLesson(mockSock, WEB_STUDENT_JID, detectedGrade, 0);

        if (introText) historyManager.addMessage(WEB_STUDENT_JID, 'agent', introText, Date.now());
        if (taskText) historyManager.addMessage(WEB_STUDENT_JID, 'agent', taskText, Date.now() + 500);

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          introMessage: introText,
          taskMessage: taskText,
          lessonDelivered: lesson,
          type: 'lesson_delivered'
        }));
        return;
      }

      // C. Generate autonomous Sudanese Arabic response via Gemini
      const reply = await generateClientResponse(WEB_STUDENT_JID, WEB_STUDENT_NAME, text);
      historyManager.addMessage(WEB_STUDENT_JID, 'agent', reply, Date.now());

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ reply, type: 'text' }));
    } catch (err) {
      console.error('[WebChat Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, () => {
  console.log('\n===============================================================');
  console.log(`  🌐 محاكي الويب جاهز ويعمل الآن!`);
  console.log(`  🔗 افتح الرابط التالي في المتصفح:`);
  console.log(`     http://localhost:${PORT}`);
  console.log('===============================================================\n');
});
