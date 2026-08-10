/**
 * Normaliza telefone BR pro formato canônico do repo: dígitos E.164 sem "+",
 * COM o 9º dígito (13 dígitos, ex: 5511987654321).
 *
 * Aceita: com/sem +55, com/sem 9º dígito, com máscara. Retorna null quando o
 * número não é normalizável (fixo, curto demais, internacional não-BR etc.) —
 * o chamador decide pular/logar.
 */
export function normalizeBrPhone(raw: string): string | null {
  let digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // Remove zeros de operadora/discagem (021, 0...)
  digits = digits.replace(/^0+/, '');

  if (digits.startsWith('55') && digits.length >= 12) {
    // já tem DDI
  } else if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  } else {
    return null; // internacional não-BR ou tamanho inválido
  }

  if (digits.length === 13) {
    // 55 + DDD(2) + 9 dígitos — celular completo
    const subscriber = digits.slice(4);
    return subscriber.startsWith('9') ? digits : null;
  }

  if (digits.length === 12) {
    // 55 + DDD(2) + 8 dígitos — celular antigo sem o 9º dígito (assinante 6-9)
    const ddd = digits.slice(2, 4);
    const subscriber = digits.slice(4);
    if (/^[6-9]/.test(subscriber)) return `55${ddd}9${subscriber}`;
    return null; // fixo (2-5) — não recebe WhatsApp de campanha
  }

  return null;
}
