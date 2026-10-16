const FEMALE_SELF_DESCRIPTION = /(?:\b(?:i am|i'm|im)\s+(?:a\s+)?(?:girl|woman|female)\b|(?:أنا|انا|إني|اني)\s*(?:طالبة|بنت|أنثى|خايفة|ضعيفة|عايزة|محتاجة|جاهزة|ماشة|متأكدة|حابة)(?=$|[\s،.!؟]))/iu;
const MALE_SELF_DESCRIPTION = /(?:\b(?:i am|i'm|im)\s+(?:a\s+)?(?:boy|man|male)\b|(?:أنا|انا|إني|اني)\s*(?:طالب|ولد|ذكر|خايف|ضعيف|عايز|محتاج|جاهز|ماشي|متأكد|حابب)(?=$|[\s،.!؟]))/iu;

export function inferContactGender(messages = []) {
  let femaleEvidence = 0;
  let maleEvidence = 0;

  for (const message of messages) {
    if (message?.role !== 'client' || typeof message.text !== 'string') continue;
    if (FEMALE_SELF_DESCRIPTION.test(message.text)) femaleEvidence += 1;
    if (MALE_SELF_DESCRIPTION.test(message.text)) maleEvidence += 1;
  }

  if (femaleEvidence > maleEvidence) {
    return { value: 'female', confidence: 'inferred from self-description' };
  }
  if (maleEvidence > femaleEvidence) {
    return { value: 'male', confidence: 'inferred from self-description' };
  }
  return { value: 'unknown', confidence: 'not clearly stated' };
}
