import readline from 'readline';
import { config } from './config.js';
import { historyManager } from './history.js';
import { generateClientResponse } from './ai.js';
import { lessonManager } from './lesson_manager.js';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const simJid = 'simulation_student@s.whatsapp.net';
let studentName = 'طالب تجريبي (Es Student)';

// Mock socket to capture lesson delivery and feedback in the terminal
const mockSock = {
  async sendMessage(jid, content) {
    if (content.text) {
      console.log(`\n🤖 [مستر مازن]:\n${content.text}\n`);
    } else if (content.video) {
      console.log(`\n🎬 [مستر مازن أرسل فيديو]: ${content.caption || 'فيديو الحصة'}\n`);
    }
  },
  async sendPresenceUpdate() {}
};

console.log('===============================================================');
console.log('  مرحباً بك في المحاكي المباشر لوكيل مستر مازن (eShool Agent)');
console.log('===============================================================');
console.log(`- تم تفعيل الذاكرة الدائمة (Es Contact Activated ⭐)`);
console.log(`- يمكنك التحدث مع الوكيل كأنك طالب جديد في الواتساب.`);
console.log(`- اكتب "خروج" أو "exit" لإنهاء المحادثة.`);
console.log('---------------------------------------------------------------\n');

historyManager.saveContact(simJid, studentName);

function promptUser() {
  rl.question('👤 [أنت (الطالب)]: ', async (input) => {
    const text = input.trim();
    if (!text) {
      return promptUser();
    }
    if (text.toLowerCase() === 'exit' || text === 'خروج') {
      console.log('\nمع السلامة! بالتوفيق.');
      rl.close();
      process.exit(0);
    }

    try {
      // 1. Save student message to history
      historyManager.addMessage(simJid, 'client', text, Date.now(), studentName);

      // 2. Check if student submitted homework
      if (lessonManager.hasActiveLesson(simJid)) {
        console.log('\n⏳ [جاري تصحيح الواجب بواسطة الذكاء الاصطناعي...]');
        const handled = await lessonManager.handleTaskSubmission(mockSock, simJid, text, studentName);
        if (handled) {
          return promptUser();
        }
      }

      // 3. Check if grade was mentioned for first lesson delivery
      const detectedGrade = lessonManager.detectGrade(text);
      const student = lessonManager.getStudent(simJid);
      if (detectedGrade && !student) {
        console.log(`\n🎓 [تم اكتشاف المرحلة: ${detectedGrade}]`);
        await lessonManager.deliverLesson(mockSock, simJid, detectedGrade, 0);
        return promptUser();
      }

      // 4. Generate general autonomous response via Gemini
      console.log('\n⏳ [مستر مازن يكتب الآن...]');
      const reply = await generateClientResponse(simJid, studentName, text);
      historyManager.addMessage(simJid, 'agent', reply, Date.now());

      console.log(`\n🤖 [مستر مازن]:\n${reply}\n`);
    } catch (err) {
      console.error('\n❌ خطأ أثناء توليد الرد:', err.message);
    }

    promptUser();
  });
}

promptUser();
