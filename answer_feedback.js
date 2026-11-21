function normalizeFeedbackText(text) {
  return String(text || '')
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function getAnswerFreeHint(expectedAnswers, explanation, fallback = 'راجع قاعدة الدرس وحاول تاني.') {
  const hint = typeof explanation === 'string' && explanation.trim()
    ? explanation.trim()
    : fallback;
  const normalizedHint = ` ${normalizeFeedbackText(hint)} `;
  const answers = Array.isArray(expectedAnswers) ? expectedAnswers : [expectedAnswers];
  const revealsAnswer = answers.some(answer => {
    const normalizedAnswer = normalizeFeedbackText(answer);
    return normalizedAnswer && normalizedHint.includes(` ${normalizedAnswer} `);
  });
  return revealsAnswer ? fallback : hint;
}
